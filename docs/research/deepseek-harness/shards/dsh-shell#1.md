# deepseek-harness / dsh-shell#1

## Shard shape

This shard is the **execution substrate** of deepseek-harness: every child process and every persistent shell the harness runs. It contains three capability families that stack in one direction — `packages/subprocess/*` (the `ctx.subprocess` seam and its local host provider, plus a low-level Win32 FFI library), `packages/shell/*` (the `ctx.shell` executor seam and four implementations — POSIX/Windows local and sandboxed — plus the model-facing `bash`/`pwsh` tools and their persistent-PTY twins), and `packages/terminal/*` (the `ctx.terminals` owner-scoped PTY registry and the shell backend that registers the `shell` type). The layering is strict: the **subprocess seam owns process coordinates and lifetime** (managed ranges, bounded spill-backed output, credential scrub, terminal allocation), the **shell seam owns what a command means** (request→spec resolution, deadline fusion and cause classification, the model-facing stdout/stderr merge and exit markers), and the **tool layer owns the model's view** (schema advertisement, sandbox escalation, background promotion, rendering, UI cards). The seam pattern is Cordis: a Service Definition package, one Service Provider per composition, and Consumers that never re-default what the seam resolved.

This shard is **not** the agent loop. The loop, compaction, memory and reasoning handling live in other shards; what this shard contributes to the loop is the tool-call surface the loop drives: the `bash`/`pwsh` tool definitions and their results, the job-runtime hand-over when a command outlives its timeout, and the exact marker vocabulary the model is taught to read.

---

## Per-file notes

### packages/shell/shell/src/types.ts
- **Purpose:** The vocabulary of the `ctx.shell` seam — the contract every executor implements and every tool consumes.
- **Key abstractions:** `ShellExecRequest` (all fields optional) vs `ShellExecSpec` (fully resolved, required); `ShellRunResult`; `ShellProcess` / `ShellExecution` (one handle, two projections); `ShellProcessRead`; `ShellObservedStreams`; `ShellExpiryPolicy = 'kill' | 'none'`; `ShellSandboxInfo`.
- **Data flow:** caller → `resolve(request)` → `ShellExecSpec` → `execute(spec)` → `ShellExecution`; `result()` is a memoized foreground projection over the same process `readOutput()` drains.
- **Non-obvious design decisions:** `timedOut` and `aborted` are **mutually exclusive** — one fused deadline drives both, so a timeout racing an abort reports the *first* cause, not both (`types.ts:146-158`). The spec carries `stdoutMaxBytes` separately from stderr's cap, so a trusted in-process consumer can raise stdout only. `dshEnv` merges *after* ordinary `env`, so a caller can never displace a managed `DSH_*` fact.
- **Edge cases / failure handling:** `ShellProcess.done` never rejects — a provider rejection settles as `killed` with the error on the read path, while `result()` carries the same failure as its rejection. `readOutput()` is consuming and reports `lossy` plus spill paths.
- **Surprising:** "foreground" is a property of *what the caller awaits*, not of the spawn; one spawn serves both projections.

### packages/shell/shell/src/index.ts
- **Purpose:** The abstract `ShellExecutor` Service Definition registered as `ctx.shell`.
- **Key abstractions:** `resolve(request): ShellExecSpec` (abstract) and `execute(spec): ShellExecution` (abstract); `sandboxMode` getter.
- **Data flow:** implementation-specific; the class only fixes the contract and the `ctx.shell` registration.
- **Non-obvious design decisions:** the class doc enumerates the semantics an implementation *must* honour — `result()` rejects only for infrastructure failures; nonzero exits, timeout kills and abort kills all *resolve*; `onExpiry: 'none'` arms no deadline at all. Job ids/ownership/notices are explicitly delegated to `ctx.jobs` so executors stay session-independent.
- **Edge cases / failure handling:** loading a second implementation throws (Cordis duplicate-service behaviour) — one executor per composition.
- **Surprising:** the seam is explicitly **task-free**: `execute()` returns a live handle, and task semantics live in the job registry.

### packages/shell/shell/src/render.ts
- **Purpose:** The shared exit-status marker contract: `parseExitStatus()`.
- **Key abstractions:** `ParsedExitStatus` = `{ body } & ({ exitCode } | { signal })`.
- **Data flow:** tool renderer appends `\n[exit code: N]` / `\n[killed by signal: X]` → the Web terminal card parses the rendered string back into body + pill.
- **Non-obvious design decisions:** the marker is *consumed* from the body because the UI shows the exit status as its own pill — leaving it in would render the exit twice. The regex requires a **leading newline and end-of-string**, so ordinary output that merely ends in marker-like text is not misread as a failure.
- **Edge cases / failure handling:** markers no pill shows (timeout, sandbox denial) stay in the body.
- **Surprising:** the same parse is re-exported by both `dsh-tool-bash` and `dsh-tool-pwsh`, and the Web card model mirrors it without importing Host code.

### packages/shell/bash-local/src/index.ts
- **Purpose:** The default POSIX executor: every command is a fresh, non-login `bash -c` with no rc files.
- **Key abstractions:** `LocalBashExecutor` (extends `ShellExecutor`); `ENV_OVERRIDES` (`NO_COLOR`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`); `assertServiceableBashConfig`; `Config` (volatile budgets).
- **Data flow:** `resolve()` clamps `timeoutMs` against `maxTimeoutMs` and fills `workdir`/`stdoutMaxBytes` → `executeArgv()` fuses the deadline → `ctx.subprocess.spawn` with explicit per-stream byte caps and `graceMs` → the settled outcome is projected into `ShellRunResult`.
- **Non-obvious design decisions:** **one fused deadline** (`deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')`) serves both the timeout and the caller's abort; only the executor's own timeout reason counts as `timedOut`, everything else is `aborted` (`index.ts:216-227`). The deadline *starts before argv preparation*, so preparation is inside the budget and a preparation timeout returns an empty settled result rather than throwing. A **provider failure becomes the whole stderr stream**: the stage-neutral note is served by a synthetic offset reader so every observer sees it, and the consuming `readOutput()` folds it in exactly once (`index.ts:284-297`, `:342-363`).
- **Edge cases / failure handling:** a synchronous spawn throw is contained into the same settled-killed shape as an asynchronous rejection; a rejection that follows the executor's *own* `kill()`/abort is classified as the terminal outcome, not a provider failure; an unprintable provider rejection still settles with `unprintable provider failure`.
- **Surprising:** env layering is fixed and one-way — terminal overrides, then caller `env`, then the trusted `dshEnv` snapshot last — while the subprocess service scrubs ambient `DSH_*` independently, so a stale ambient fact can never reach the child.

### packages/shell/bash-local/tests/executor.spec.ts
- **Purpose:** The executor's behavioural contract, 563 lines.
- **Key abstractions:** `setup()` mounts a real `LocalSubprocessRuntime` with a temp spill dir; `readUntil()` polls the consuming cursor.
- **Data flow:** drives the real executor against real `bash`; asserts on `ShellRunResult` fields.
- **Non-obvious design decisions:** the suite pins the **mutual exclusion** of `timedOut`/`aborted`, that a self-killed command is *neither*, that a TERM-trapping child dies by SIGKILL after `graceMs`, and that a background process **survives executor-fiber disposal** but dies with the subprocess service.
- **Edge cases / failure handling:** the "hanging backend" fixture proves the caller's abort stays the first cause even when the process outlives the deadline.
- **Surprising:** the kill-escalation test avoids a fixed sleep — the child echoes *after* arming its trap, so the marker guarantees SIGTERM is already ignored.

### packages/shell/bash-local/tests/settings.spec.ts
- **Purpose:** Live-config behaviour of the executor's volatile budgets.
- **Key abstractions:** `liveConfig(ctx, LocalBashExecutor, {...})` from the settings package.
- **Data flow:** a Loader update changes the live config; the next `resolve()` must observe it.
- **Non-obvious design decisions:** a **stored budget the executor cannot use fails at the next command, not at the profile write** — the settings panel validates the schema, but "positive and finite" and the `MAX_TIMER_DELAY_MS` bound are not expressible in it, so `assertServiceableBashConfig` re-checks at resolve time.
- **Edge cases / failure handling:** `graceMs: Number.MAX_SAFE_INTEGER` is refused with a named message.
- **Surprising:** the executor fiber identity is asserted unchanged across the update — budgets are sampled per call, not per mount.

### packages/shell/pwsh-local/src/index.ts
- **Purpose:** The Windows counterpart of `bash-local`, a deliberate call-for-call mirror.
- **Key abstractions:** `PwshLocalExecutor`; `ENV_OVERRIDES` without `TERM=dumb` (a POSIX concept); `ENCODING_PREAMBLE`; `protected argv(spec)` as the argv seam the sandbox subclass wraps.
- **Data flow:** same as bash-local, except the command rides as **one argv element** to `pwsh -Command`.
- **Non-obvious design decisions:** the command string is passed as a single `-Command` argument because PowerShell parses the text itself and **no intermediate shell exists**, so there is no quoting layer to escape and native `C:\...` paths pass through unchanged. `ENCODING_PREAMBLE` pins UTF-8 output because the collector decodes as UTF-8 while Windows PowerShell 5.1 writes the OEM code page.
- **Edge cases / failure handling:** the preamble rides on line 1 after `; ` so PowerShell error line numbers stay accurate; a `param(...)`/`using` script cannot run under it (documented limit).
- **Surprising:** `pwshPath` is re-probed from disk only when the *declared* path changes — resolution is a pure function of `(configured, env, platform)`.

### packages/shell/pwsh-local/src/resolve.ts
- **Purpose:** Dependency-free pwsh executable resolution.
- **Key abstractions:** `candidatePwshPaths(env)`; `resolvePwshPath(configured, env, platform)`.
- **Data flow:** config → candidate list (PowerShell 7 → PATH entries → Windows PowerShell 5.1) → `lstat` probe → resolved path.
- **Non-obvious design decisions:** it lives in its own dependency-free module so the repository's **coverage-gate probe shares the exact definition the suites use** — a probe that resolved differently from the code under test could exempt a file whose suites actually run. `lstat` (not `stat`) is used so the Microsoft Store **execution alias** is visible where `stat` hits the target's ACL.
- **Edge cases / failure handling:** PATH entries may carry surrounding quotes from `setx`-style definitions; a directory candidate never matches.
- **Surprising:** on non-Windows it returns the bare name `pwsh` regardless of the environment.

### packages/shell/bash-sandbox/src/index.ts
- **Purpose:** The confining bash executor: it wraps the exact `['bash','-c',cmd]` argv through `ctx.sandbox`.
- **Key abstractions:** `SandboxBashExecutor` (extends `LocalBashExecutor`); a per-process `processFacts` map.
- **Data flow:** `resolve()` stamps the per-call policy (session override or deployment default) → `execute()` prepares the confined argv → the inherited subprocess path spawns it → at settlement the outcome is classified and the facts are stamped.
- **Non-obvious design decisions:** facts are retained **per handle**, not in a shared "latest wrap" value, because a provider may vary enforcement and diagnostic dialect between overlapping calls. **Runner failure outranks denial**, because the command did not run; a confined mode with no usable runner throws `SANDBOX_UNAVAILABLE` rather than running unconfined.
- **Edge cases / failure handling:** `danger-full-access` bypasses the provider entirely and stamps `denied: false`; a provider rejection is attributed to the runner only when its `ENOENT`/`EACCES` path or syscall independently names `argv[0]`.
- **Surprising:** `decorateResult()` rewrites `ex.result` **in place** rather than wrapping the handle — the per-process facts and `onProcessDone` key on the exact instance.

### packages/shell/bash-sandbox/src/helpers.ts
- **Purpose:** Denial classification over the shared sandbox dialect.
- **Key abstractions:** `classifyDenial(result, signatures)`; re-exports `isRunnerSpawnFailure`, `classifyRunnerFailure`, `matchesSignature`.
- **Data flow:** settled result → signature match against the active backend's stderr dialect.
- **Non-obvious design decisions:** denial is *inferred from a failed command's stderr*, so it is portable across backends but conservative.
- **Edge cases / failure handling:** a clean exit or a signal kill is never a denial.
- **Surprising:** the bash and pwsh helpers are not the same file — the pwsh one carries the full classification dialect, the bash one delegates to `@deepseek-ai/dsh-sandbox`.

### packages/shell/pwsh-sandbox/src/helpers.ts
- **Purpose:** The full runner-failure / denial classification dialect.
- **Key abstractions:** `isRunnerSpawnFailure(error, runnerProgram, workdir)`; `classifyRunnerFailure(exitCode, stderr, rules)`; `matchesSignature(exitCode, stderr, signatures)`.
- **Data flow:** a settled process's exit code + stderr + the wrap's structured rules → a classification.
- **Non-obvious design decisions:** a rule needs a nonzero exit, an optional exit-code gate, and a fatal signature on one stderr line **after exact informational lines are excluded**; the windows-acl rule is exit-gated on 127, so a confined command that merely *prints* the signature on a different exit is not a runner failure. A blank/whitespace-only signature is ignored while valid neighbours stay active.
- **Edge cases / failure handling:** `isRunnerSpawnFailure` independently rules out the caller-owned cwd before attributing `ENOENT`/`EACCES` to the runner.
- **Surprising:** the workdir is checked at classification time, not atomically with the spawn — the comment says so explicitly: concurrent path replacement may change attribution but cannot permit an unconfined execution.

### packages/shell/shell-env/src/index.ts
- **Purpose:** The trusted `DSH_*` environment every model shell call receives.
- **Key abstractions:** `ShellEnvRegistry` service; `BashEnvContributor`; `BashEnvVariableInfo`.
- **Data flow:** `collect(execution)` → built-ins (`DSH_HOME`, `DSH_SHELL=1`, `DSH_SESSION_ID`, `DSH_PROFILE`, `DSH_PROFILE_DIR`) → contributor resolvers (sorted by name) → a frozen, key-sorted snapshot → `ShellExecRequest.dshEnv`.
- **Non-obvious design decisions:** the namespace is **rebuilt for every call** and ambient `DSH_*` values are discarded by the executor, so nested harnesses and concurrent parent/child agents cannot leak stale identities and `process.env` is never mutated. Contributors **declare their keys up front**, so duplicate ownership is detected before the first command; a resolver returning an undeclared or non-string value fails the call loudly.
- **Edge cases / failure handling:** reserved built-in keys cannot be claimed; a key must match `^[A-Z][A-Z0-9_]*$` after the prefix; every key needs a non-empty description.
- **Surprising:** `list()` enumerates plugin-contributed variables **only** — the built-ins are deliberately excluded, and a TODO marks the trap.

### packages/shell/tool-bash/src/index.ts
- **Purpose:** The model-facing `bash` tool.
- **Key abstractions:** `defineTool({ name:'bash', parameters, output, execute, presentCall, presentResult })`; `canonicalBashResult`; `StartedJob`; `validateBashArgs`.
- **Data flow:** model args → validate → resolve per-call sandbox policy → optional escalation through `ctx.approval` → `ctx.shellEnv.collect(exec)` → `ctx.shell.resolve(...)` → `ctx.shell.execute(...)` → canonical result object → `render`/`presentResult`.
- **Non-obvious design decisions:** **every command is a job from its start** when a registry is composed — even a foreground call registers its process and waits on that job, so the command is visible and killable from the moment it starts. A foreground call that outlives its timeout is **promoted**: the command keeps running as the job it already was, and the result is seeded with *one consuming registry read* so `job_output` continues exactly where the result stopped (`index.ts:340-354`). Registration is best-effort — a registry that refuses the job at its start falls back to the deadline kill and the `timeoutMs` description advertises the hand-over only when it holds.
- **Edge cases / failure handling:** `run_in_background` is rejected when disabled *and* when no registry is composed; an aborted run throws the structured `TOOL_ABORTED` `HarnessError`; the executor's own timeout and the caller's abort are separate classifications.
- **Surprising:** the tool never exposes `stdin`, `env` or `stdoutMaxBytes` — the request is built from named args plus the registry-collected `dshEnv`, so model-supplied keys cannot replace managed values.

### packages/shell/tool-bash/src/render.ts
- **Purpose:** The model-facing result text.
- **Key abstractions:** `renderResult`; `renderPromoted`; `renderJobRead`; `streamText`.
- **Data flow:** `ShellRunResult` → stdout, then a marked `[stderr]` section, then conditional marker lines → the model.
- **Non-obvious design decisions:** **non-zero exits are reported, not errored** — the model decides how to react; only infrastructure failures surface as `isError`. The exit marker is kept **last** because `parseExitStatus` anchors there.
- **Edge cases / failure handling:** a command may trap SIGTERM and exit 0 after a timeout, so the timeout marker is emitted independently of the exit code; an outside stop (`[stopped: <reason>]`) is placed *before* the signal marker so the model reads a reason rather than a failure.
- **Surprising:** truncation is announced with the spill path, and the sandbox escalation hint is appended only when the composition advertises escalation.

### packages/shell/tool-bash/src/background.ts
- **Purpose:** Adapting a shell process handle onto the generic `ctx.jobs` vocabulary.
- **Key abstractions:** `processOutcome`; `processSources`; `ringDelta`; `processJob`.
- **Data flow:** process handle → job outcome / job output sources / job ring chunks → rendered delta.
- **Non-obvious design decisions:** `processSources()` binds **lazily** because the process is spawned inside the starter, after the registry admitted the job — a read before the spawn yields nothing and the pump leaves the model's consuming cursor untouched. `processJob()` keeps the asynchronous preparation *inside* the job's `done`, so preparation failure and process settlement share one completion.
- **Edge cases / failure handling:** a reader that throws is logged once and its stream stops; the job runs on to its own settlement.
- **Surprising:** a nonzero command exit maps to job `completed`, not `failed` — exactly like the foreground rendering; a TODO marks the missing explicit infrastructure-failure outcome.

### packages/shell/tool-pwsh/src/index.ts
- **Purpose:** The model-facing `pwsh` tool — a deliberate twin of `dsh-tool-bash`.
- **Key abstractions:** `PwshForegroundResult`; `validatePwshArgs`; `pwshDescription(windowsSandbox)`.
- **Data flow:** same shape as the bash tool, over a pwsh executor.
- **Non-obvious design decisions:** the **tool description teaches the platform's sandbox contracts to the model** — that read-only pwsh runs in PowerShell `ConstrainedLanguage` (so `[System.IO.*]::`, `Add-Type`, COM and reflection fail with "only core types" errors) and that in both confined modes programs cannot open named pipes, so capturing another program's output through piped stdio fails with `EPERM` (`index.ts:141-147`). Without this the model retries the same failing construct instead of escalating.
- **Edge cases / failure handling:** on Windows a force-killed command settles as `[exit code: 1]` **without** a signal marker, so the prompt section teaches the model to read a bare exit 1 after an interruption as a termination.
- **Surprising:** the escalation fields and the sandbox-free variants of the tool are literally the same code path guarded by `escalationModes.length > 0`.

### packages/shell/tool-bash-persistent/src/index.ts
- **Purpose:** The model-facing persistent `bash` tool over the owner-scoped PTY seam.
- **Key abstractions:** `PersistentShells` registry; `markers()`; `wrapCommand()`; `commandOutput()`; `partialOutput()`; `retainedScrollback()`.
- **Data flow:** `ctx.terminals.spawn` → `stty -echo` → wrap the command with unique start/end markers → send → poll the scrollback in 1 000-line pages → extract the span between the *real* markers → render with a status marker.
- **Non-obvious design decisions:** **marker-anchored extraction** — a unique nonce marker pair carries the exit status, so prompts and echoed input never leak into results; the wrapper stays on **one physical line** because an interactive bash prints PS2 for embedded newlines before executing the buffer. **Reset, never repair**: any uncertain state (an explicit `exit`, a timeout, a send failure, an abort) closes the shell and the next call starts fresh, and the model is told so explicitly (`index.ts:19`).
- **Edge cases / failure handling:** the shell reads stdin again without printing the end marker (`exec`, an interrupt, an interactive child) → return the captured partial output instead of spinning to the deadline; a torn completion marker waits for the status digits.
- **Surprising:** commands for one owner are **serialised through a per-owner queue** (`index.ts:402-412`), so two concurrent calls cannot interleave in one shell; the shell is created lazily and killed on plugin disposal or owner teardown.

### packages/shell/tool-pwsh-persistent/src/index.ts
- **Purpose:** The PowerShell twin of the persistent bash tool.
- **Key abstractions:** the same registry/polling/reset contract with a backtick-escaped wrapper and `$LASTEXITCODE` status.
- **Data flow:** same as bash-persistent, with `Invoke-Expression` inside the wrapper and a `$?`/`$LASTEXITCODE` fallback for a terminating PowerShell error.
- **Non-obvious design decisions:** the wrapper escapes the body with **backticks** (backtick first, so the escapes this function inserts are never re-escaped; `$` so nothing expands at wrapper-construction time; `\r\n`/ESC so multi-line commands and raw control bytes ride one physical input line without PSReadLine mangling). The echoed END nonce can never fabricate completion because the status regex needs digits immediately after it.
- **Edge cases / failure handling:** PSReadLine's echo of the wrapper is stripped from the captured span; a wrapper that wraps across the terminal width may leave a partial echo (documented limit).
- **Surprising:** the shell's `prompt` function belongs to the *backend*, not the tool — a model that redefines `prompt` removes the readiness marker and the shell settles on the silence tier instead.

### packages/subprocess/subprocess/src/types.ts
- **Purpose:** The `ctx.subprocess` vocabulary.
- **Key abstractions:** `SubprocessSpawnSpec`; `SubprocessStdio`; `SubprocessCollect`; `SubprocessOutputReader`; `SubprocessHandle`; `SubprocessOutcome`; the terminal primitive types.
- **Data flow:** spec → provider → handle → `done` (direct exit facts) plus `collected` readers (offset-based) and `waitForExit()` (managed-range quiescence).
- **Non-obvious design decisions:** the seam applies **no defaults** — every disposition, limit and directory is explicit, so the caller's config decides them and the `dsh-shell` request/spec split is the owning template. Collect-mode readers are **cursor-free**: offsets are whole-stream byte coordinates the caller owns, so independent readers never consume one another's output. `SubprocessOutcome` deliberately carries **no** timeout/cancellation classification — the caller reads the signal it owns.
- **Edge cases / failure handling:** a read whose offset slid out of the in-memory tail is `lossy` and points at the spill file; `waitForExit()` observes the *managed range*, not just the direct command.
- **Surprising:** `SubprocessTerminalSignal` is kept member-identical to `TerminalSignal` in `dsh-terminal` without a cross-seam dependency — "change both together".

### packages/subprocess/subprocess/src/index.ts
- **Purpose:** The abstract `SubprocessRuntime` seam plus the shared environment scrub.
- **Key abstractions:** `SubprocessRuntime` service; `scrubbedParentEnv()`; `SENSITIVE_ENV_PATTERN`; `SubprocessExecutableNotFoundError`.
- **Data flow:** `scrubbedParentEnv()` → the canonical base every child starts from → explicit `env` merges after the scrub.
- **Non-obvious design decisions:** the credential scrub is **case-insensitive** because Windows environment names are — a parent `dsh_*` entry would otherwise survive and read back as `$env:DSH_*` in the child. The same function re-layers the **proxy** variables so a child Node honours them (a child Node ignores inherited proxies unless `NODE_USE_ENV_PROXY` is set), undoing the parent's own normalisation — `undefined` removes a name the user never set.
- **Edge cases / failure handling:** an explicitly forwarded credential survives the scrub; `undefined` is a tombstone that removes an ordinary ambient entry.
- **Surprising:** it is exported as a plain function so spawners that cannot route through the service (node-pty backends, SDK-managed transports) share the **one** scrub definition.

### packages/subprocess/subprocess-local/src/output.ts
- **Purpose:** Bounded output tails and private spill files.
- **Key abstractions:** `OutputCollector`; `SpillOptions`; `prepareManagedProcessBinding`; `logSpillFailure`.
- **Data flow:** stream `'data'` → `push(chunk)` → in-memory tail (byte-exact at the cap) + optional spill file → `readFrom(offset)` → `{ text, nextOffset, lossy, spillPath }`.
- **Non-obvious design decisions:** **tail-keep rationale**: errors and final results cluster at the end of command output, so the spill file covers the head (`output.ts:126-128`). The spill file is opened `O_EXCL` with mode `0600` under a `0700` per-process directory with a random suffix, defeating prediction and symlink planting in shared tmp dirs; the path is published **only after the open succeeded**, so a failed open never lets `discardSpill` unlink a path this process did not create. Spilling is best-effort because `push()` runs inside the stream's `'data'` listener, where a thrown error would become an uncaught exception.
- **Edge cases / failure handling:** `ENOENT` (a temp cleaner removed the directory), `EACCES`, `EMFILE`, `ENOSPC` all discard the spill, report once, and keep collecting the in-memory tail; a failed final close withdraws the spill path while every in-memory read keeps working.
- **Surprising:** the per-process spill directory is removed at process exit **only when it holds no completed spill file** — completed spills are retained as recovery artifacts until an external cleanup.

### packages/subprocess/subprocess-local/src/spawn.ts
- **Purpose:** Shared process plumbing for the local provider.
- **Key abstractions:** `childEnv`; `validateSubprocessSpec`; `bindManagedProcess`; `spawnSubprocess`; `fallbackOwner`; `killGroup`; `taskkillProcessTree`.
- **Data flow:** spec → validation → platform launch → `bindManagedProcess` binds stdio, outcome, abort and termination lifecycle → a live handle.
- **Non-obvious design decisions:** the grace timer is **deliberately not cleared** when the direct command settles — forced termination must still reach range survivors after the spawned command exits. The escalation is `SIGTERM` at the deadline and `SIGKILL` after `graceMs`; `terminate()` is idempotent. `sleepTick` keeps the timer ref'd so an awaited teardown cannot exit the event loop while claiming quiescence.
- **Edge cases / failure handling:** the stdout/stderr drain has its own `graceMs` bound so an inherited descriptor held by a survivor cannot hold the outcome open forever; `terminateForHostExit()` is a synchronous, timer-free, promise-free last resort.
- **Surprising:** `childEnv` implements **Windows case-insensitive** override semantics on Windows (case-insensitive removal + re-add) while POSIX keeps plain merge.

### packages/subprocess/subprocess-local/src/linux-scope.ts
- **Purpose:** Linux user-systemd transient-scope launch and managed-range ownership.
- **Key abstractions:** `probeLinuxBootstrap`; `probeLinuxScope`; `probeLinuxNative`; `linuxManagerListener`; `confirmLinuxManager`; `SystemdScopeOwner`; `LinuxScopeStartup`; `launchLinuxScope`; `prepareLinuxTerminalScope`.
- **Data flow:** probe → capability verdict → private launch-request file → `systemd-run --user --scope --collect -- …` → one-shot bootstrap restores cwd/env and `execve`s the target → the parent polls `systemctl --user show` for `TasksCurrent` to prove the range empty.
- **Non-obvious design decisions:** the scope is treated as established only once the **launch request has been consumed** — a unit that is "active with zero processes" is not necessarily empty (a payload killed before entering the cgroup leaves the unit active forever), so the proof is "consumed request AND zero tasks", not "unit inactive". A leftover empty scope is released with `systemctl --user stop` so transient units cannot accumulate.
- **Edge cases / failure handling:** the literal-argv option `--expand-environment=no` is dropped only for a `systemd-run` that *rejects* it (pre-v254), and the probe is retried without it. A scope launch whose bootstrap never consumed its request raises `LinuxScopeNotStartedError`, which tells the selector to probe again.
- **Surprising:** the user manager is confirmed by reading `/proc/net/unix` for a listener on `$XDG_RUNTIME_DIR/systemd/private` — a socket file left by a crashed listener does not count, because the kernel only lists a bound socket while a process holds it.

### packages/subprocess/subprocess-local/src/linux-scope-selector.ts
- **Purpose:** The Linux containment decision state machine.
- **Key abstractions:** `LinuxScopeObservations`; `LinuxScopeDecision`; `LinuxScopeState`; `LinuxProbeTrigger`.
- **Data flow:** `select()` → the current state → probe / confirm / fall back → a decision stamped with a `generation`.
- **Non-obvious design decisions:** the probe is expensive (it forks the host), so it runs **once** and again only after an event invalidates the verdict: a scope launch that never started its target, a different manager listener appearing under a negative verdict, or the `systemd-run` binary changing under a positive one. A positive verdict confirms the manager on *every* selection.
- **Edge cases / failure handling:** the manager listener is read **before** the probe, so a manager that starts during a failed probe counts as a new listener next time.
- **Surprising:** selection is synchronous, so a decision stays valid for the launch that follows it.

### packages/subprocess/subprocess-local/src/spawn-runner.ts
- **Purpose:** The one-shot Linux exec bootstrap and the Windows Job-owning subprocess runner.
- **Key abstractions:** `WindowsJobRunner`; `runSpawnRunner`; `reportSpawnRunnerFailure`; `execLinuxTarget`; `asSpawnError`.
- **Data flow:** parent → private runner process → (Linux: read the launch request, `chdir`, `execve` the target) / (Windows: IPC `start` → resolve the executable → create the target suspended → assign the Job → resume → poll → publish `target-exit`).
- **Non-obvious design decisions:** the Windows runner **isolates its own stdio** (fd 0-2 ignored, fd 3 IPC, target carriers on fd 4-6, optional fd 7 control) so the target never inherits the runner's streams. `start()` yields with `setImmediate` before loading the bindings so a `terminate` arriving on IPC during startup is honoured. The Linux `execve` falls back to `/bin/sh` on `ENOEXEC`, and PATH search continues past `EACCES` (remembering the first permission failure) but stops on any other error.
- **Edge cases / failure handling:** the runner maps only a **promised subset** of Win32 creation errors to Node-shaped codes; everything else is `UNKNOWN`. IPC disconnect terminates and closes the unique Job immediately.
- **Surprising:** a *single* private runner process owns the Job handle, so "the runner exits" and "the range is empty" are separable facts.

### packages/subprocess/subprocess-local/src/runner-protocol.ts
- **Purpose:** Closed private transports shared by the native runners.
- **Key abstractions:** `LinuxLaunchRequest`; `WindowsStartRequest` / `WindowsTerminateRequest` / `WindowsRunnerResult`; `SerializedRunnerError`; `LinuxLaunchFiles`.
- **Data flow:** parent writes a `0600` launch-request file → the bootstrap **reads and unlinks** it (one-shot) → errors are published beside it as a strictly-parsed `startup-error.json`.
- **Non-obvious design decisions:** every message is parsed with an **exact-key** validator (`hasExactKeys`), so an unexpected key is a rejection rather than a silently ignored field; error records are bounded to five Node-shaped fields.
- **Edge cases / failure handling:** the private directory is `0700`; cleanup refuses to follow a substituted symlink (it unlinks the symlink instead of the directory).
- **Surprising:** the terminate request must be the *exact* payload-free `{ type: 'terminate' }` — a payload is not a terminate.

### packages/subprocess/subprocess-local/src/runner-launch.ts
- **Purpose:** Parent-side invocation and bootstrap state for the private runner.
- **Key abstractions:** `spawnRunnerInvocation()`; `runnerInvocationAvailable()`; `runnerEnvironment()`; `consumeRunnerSelection()`; `parseRunnerTargetArgv()`; `runnerStdio()`; `resolveWindowsExecutable()`; `targetEnvironment()`.
- **Data flow:** selection → environment (target state deliberately excluded) → runner process → target argv after a private `--` delimiter.
- **Non-obvious design decisions:** the bootstrap environment **strips `NODE_*` and `TSX_*`** so the runner starts from a known state, and the target's cwd/env arrive through the request/IPC instead. `resolveWindowsExecutable` reimplements libuv/Node's Windows search order (including `NODEFAULTCURRENTDIRECTORYINEXEPATH` and quoted PATH entries) while keeping the caller's original argv[0] unchanged.
- **Edge cases / failure handling:** every Node-baseline NUL location (argv entries, cwd, env keys and values) is validated before launch.
- **Surprising:** the runner entry has three forms — `pkg`-bundled, built JS, and source via `tsx/esm` — and the probe only *checks path accessibility*, never executes a probe mode.

### packages/subprocess/subprocess-local/src/process-inspector.ts
- **Purpose:** Platform process-table inspection for terminal readiness, signals and teardown.
- **Key abstractions:** `ProcessIdentity` (pid + start time); `ProcessSnapshot`; `ProcessInspector`; `PosixProcessInspector`; `LinuxProcessInspector`; `MacProcessInspector`.
- **Data flow:** one table read per poll → `tree(rootPid)` / `session(id)` / `alive(identity)`; `isAlive(identity)` re-reads current state for signalling.
- **Non-obvious design decisions:** the table is read **at most once per poll**, so the cost of a poll is independent of how many descendants the command spawned. `alive()`/`isAlive()` match the **PID plus its start identity**, never the PID alone — a recycled PID must not inherit a stale observation. On Linux, "is the foreground group waiting for input" is proven by reading `/proc/<pid>/task/<tid>/syscall` and matching the wait against the process's fd table and controlling-terminal device.
- **Edge cases / failure handling:** zombie/dead states answer "present in the table" but never "still running"; an unreadable `/proc` yields `undefined` (unknown), never "idle"; macOS `ps` exposes neither session id nor a state column, so the macOS inspector can only answer presence and parentage.
- **Surprising:** the Linux stdin-wait probe tries several kernel syscall tables (not just `process.arch`), because user-mode emulation can expose a different table.

### packages/subprocess/subprocess-local/src/terminal.ts
- **Purpose:** The local node-pty terminal handle.
- **Key abstractions:** `LocalTerminalHandle`.
- **Data flow:** node-pty data → `output` PassThrough (with backpressure pause/resume) → exit event → outcome; `inspectActivity()` → `{ state, revision }`.
- **Non-obvious design decisions:** descendants are adopted **only while the numeric root pid still carries the spawned shell's start identity** — after the shell dies, a recycled pid's tree and session must not donate an unrelated process's children to this session's signalling. Windows teardown verifies the shell's absence through the **inspector** rather than waiting on `done`, because an externally taskkilled shell may never fire node-pty's exit notification; `settleExitIfGone` then resolves `done` itself so no consumer awaits forever.
- **Edge cases / failure handling:** SIGKILL of the terminal shell itself is refused ("terminate the terminal session instead"); each signal re-reads its own identity fence, so a failed read costs one target and never the rest of the teardown round.
- **Surprising:** the seam's "no write/inspection/signal in flight after `terminate()` settles" promise holds here only because every node-pty call is synchronous — the class comment says a first genuinely asynchronous step would require the tracking a remote provider needs.

### packages/subprocess/subprocess-local/src/shell-activity.ts
- **Purpose:** Optional shell lifecycle evidence (idle/busy) for interactive bash/zsh.
- **Key abstractions:** `ShellActivity`; `prepareShellActivity`.
- **Data flow:** a private `bashrc`/`zshenv` writes a `pid:sequence:state` record on each prompt; the inspector reads it.
- **Non-obvious design decisions:** the integration is **opt-in** and only for a plain non-login `bash -i`/`zsh -i`, so custom arguments and sandbox-wrapped executables are left untouched. Prompt evidence is **fenced against input**: `invalidate()` records the current value so a state observed *after* the user typed cannot be read as pre-input evidence. Bash requires 4.4+ and writable prompt hooks; zsh observes an empty top-level ZLE prompt, excluding `vared` and continuation prompts.
- **Edge cases / failure handling:** a non-empty `trap` list means the shell may run work without terminal input → the state is `unknown`, never `idle`.
- **Surprising:** the user's own startup files are still sourced, and the original `ZDOTDIR` is restored after the private one is used.

### packages/subprocess/subprocess-local/src/index.ts
- **Purpose:** The local `ctx.subprocess` provider.
- **Key abstractions:** `LocalSubprocessRuntime`; `internals` test hook; `terminalInspector`.
- **Data flow:** `spawn()` → validate → select containment mode → launch → bind → track in `live` → release only after the *whole managed range* is gone.
- **Non-obvious design decisions:** a handle leaves the live set only when `waitForExit()` reports the range empty — a TERM-trapping helper that outlives the leader must stay owned so teardown can still escalate it. The fallback warning is emitted **once per provider lifetime**. A host-exit finaliser is registered with `process.prependListener('exit', …)` so it runs *before* listeners that predate the service.
- **Edge cases / failure handling:** disposal terminates and **awaits** every live range (not just the direct result); a failure in one target does not prevent the others from being terminated; failures are aggregated into an `AggregateError`.
- **Surprising:** the provider has **no configuration** — every disposition and limit arrives on the spec, so deployment-varying choices stay with the caller's config.

### packages/subprocess/win32-process/src/process.ts
- **Purpose:** Typed Win32 process operations over the shared binding table.
- **Key abstractions:** `quoteArg` / `buildCommandLine`; `spawnPipedProcess`; `spawnInheritedJobProcess`; `spawnCurrentTokenJobProcess`; `drainPipe`; `waitForProcessExit`; `pollProcessExit`; `isJobEmpty`; `terminateJob`; `closeHandleChecked`.
- **Data flow:** options → STARTUPINFOW/PROCESS_INFORMATION → `CreateProcessAsUserW`/`CreateProcessW` (suspended) → `AssignProcessToJobObject` → `ResumeThread`.
- **Non-obvious design decisions:** the target starts **suspended** so it cannot execute before Job assignment. The command line is built with `CommandLineToArgvW`-correct quoting (backslashes doubled before a quote). The restricted-token path passes a **null** environment block because an explicit block through Koffi makes `CreateProcessAsUserW` fail with `ERROR_INVALID_PARAMETER`.
- **Edge cases / failure handling:** every partial failure closes exactly the handles the operation owns and terminates the suspended child; `STARTF_USESHOWWINDOW` with `SW_HIDE` preserves console inheritance and avoids `CREATE_NO_WINDOW`, which can fail restricted-token DLL initialisation.
- **Surprising:** the ordinary runner keeps the caller's original argv[0] unchanged while passing a separately resolved `applicationName` to `CreateProcessW`.

### packages/subprocess/win32-process/src/ffi.ts
- **Purpose:** The lazy koffi binding table.
- **Key abstractions:** `Win32ProcessBindings`; `CurrentTokenProcessBindings`; `Win32BindingContext`; `extendWin32ProcessBindings`.
- **Data flow:** first native operation → load `kernel32.dll`/`advapi32.dll` → bind the stdcall functions → cached for the process.
- **Non-obvious design decisions:** the struct layouts are **asserted at module load** (`STARTUPINFOW` 104 bytes, `PROCESS_INFORMATION` 24) so an ABI mismatch fails loudly rather than corrupting memory. `extendWin32ProcessBindings` lets the sandbox policy bind its own APIs through the same loaded libraries.
- **Edge cases / failure handling:** `isNullPtr` treats `undefined`, `null` and address zero as null; `errorText` formats through `FormatMessageW`.
- **Surprising:** the bindings table also exposes Node's own `uv_get_osfhandle`, which is how a runner CRT descriptor becomes an OS handle.

### packages/subprocess/win32-process/verify/abi-probe.cpp
- **Purpose:** The native evidence for every Win32 constant and offset the TypeScript duplicates.
- **Key abstractions:** a `wmain` that prints each constant/size/offset and `static_assert`s the values.
- **Data flow:** compiled against the MinGW headers with `g++ -std=c++20 -municode`, then run.
- **Non-obvious design decisions:** the probe is the *source of truth* for the recorded offsets, and the TS side asserts against it — the comment in `ffi.ts` says the probe "remains the evidence for the other recorded offsets and constants".
- **Edge cases / failure handling:** the `static_assert`s make a header/TypeScript divergence a compile-time failure.
- **Surprising:** it also pins pointer and handle widths, which the TS constants do not otherwise express.

### packages/subprocess/subprocess-local/src/windows-job.ts
- **Purpose:** Windows parent-side launch and ownership for the private Job runner.
- **Key abstractions:** `probeWindowsJob`; `WindowsJobOwner`; `launchWindowsJob`.
- **Data flow:** spawn the runner with isolated stdio → IPC `start` → the runner creates the target and publishes `target-exit` → the parent resolves the direct outcome and the range quiescence separately.
- **Non-obvious design decisions:** the runner capability is **re-probed on every eligible spawn** (entry path, bindings, current Job support), and a native failure is reported rather than replayed through the fallback. A clean runner exit with no IPC result is an **infrastructure failure**, not a silent success.
- **Edge cases / failure handling:** `mapStartFailure` restores the caller's own cancellation reason when the runner reports the start-cancellation sentinel.
- **Surprising:** the parent's stdio for the target is carried on the runner's fd 4-6, so the parent's own streams are never touched.

### packages/subprocess/win32-process/src/control-stdio.ts
- **Purpose:** The child's CRT descriptor table for the inherited control pipe.
- **Key abstractions:** `inheritedControlStdio(api, stdio)`.
- **Data flow:** fd handles → a `STARTUPINFO.cbReserved2`/`lpReserved2` byte block → the CRT in the child.
- **Non-obvious design decisions:** the table is initialised **before Node starts** so Node does not overwrite descriptors it has already allocated; empty slots stay closed; the control descriptor must be a pipe.
- **Edge cases / failure handling:** the backing buffer must stay alive until `CreateProcess` returns.
- **Surprising:** eight-slot tables are written even though only four are used — the extra slots are explicitly closed.

### packages/terminal/terminal/src/index.ts
- **Purpose:** The owner-scoped persistent PTY registry (`ctx.terminals`).
- **Key abstractions:** `TerminalSessionService`; `TerminalError` with machine-routable codes; `SessionRecord`; `PendingSpawn`; `SpawnReservation`.
- **Data flow:** `spawn(owner, request, signal)` → reserve a name and a spawn slot → `backend.spawn(...)` → publish → `startSend` / `read` / `signal` / `kill` / `list`.
- **Non-obvious design decisions:** **publication happens only after backend setup succeeds**, and every operation is fenced to the **exact `Agent` object** (`record.owner !== owner` → `FOREIGN_SESSION`), so the model cannot reach another agent's terminal even if it learns the id. `hasOwnerActivity(owner)` spans unpublished setup through final close with **no publication gap**, which is what lets lifecycle policy fence the owner precisely. The send slot is reserved **synchronously** before the operation is returned, so a second send fails with `SEND_ACTIVE` and output never crosses operation ownership.
- **Edge cases / failure handling:** a backend that cannot clean partial startup resources rejects with `TerminalBackendCleanupError`, which the service retains as tracked owner activity; disposal aborts pending spawns, awaits their settlement, closes every session and aggregates failures — and it still clears the registries and runs owner detachers even when a close fails.
- **Surprising:** caller cancellation keeps its **exact `AbortSignal.reason`**, checked before the cancellation is rewritten.

### packages/terminal/terminal-bash/src/session.ts
- **Purpose:** The persistent PTY session: send lifecycle, readiness, bounded scrollback, teardown.
- **Key abstractions:** `LocalPtySession`; `LocalSendOperation`; `BoundedTextBuffer`.
- **Data flow:** pty bytes → decoder → sanitizer → scrollback buffer + the active operation's buffer → readiness polling → a settled send with `{ viewport, waitReason, sessionStatus, truncated }`.
- **Non-obvious design decisions:** readiness has **three bounded tiers** — an exact stdin wait from the provider (Linux only), the verified private prompt marker *with* its exact printable tail, and output silence (`inferred_idle`) — plus an absolute timeout. Evidence collected before the provider write is **discarded at the write boundary**, and a stdin wait that predates the write is not post-write readiness. `BoundedTextBuffer` evicts whole code points and counts the empty line after a trailing newline; append/evict is amortised over incoming text.
- **Edge cases / failure handling:** a prompt marker whose printable tail has not arrived yet holds the send on the exact path for `promptTailGraceMs` beyond `idleSilenceMs + handoffGraceMs`, because the marker and its tail are written by the same render — a missing tail is a delivery delay, not an absent prompt. Cancellation signals the foreground group with a **real SIGINT** after any in-flight provider write settles; it never emulates interruption by writing `\x03`.
- **Surprising:** a zero-scrollback `@xterm/headless` instance consumes the raw PTY data and returns terminal-protocol replies through the same handle, while the line sanitizer remains the only output projection.

### packages/terminal/terminal-bash/src/sanitize.ts
- **Purpose:** The streaming terminal-control sanitizer.
- **Key abstractions:** `TerminalSanitizer`; `PROMPT_MARKER_PREFIX = '133;D;'`; `CONTROLLED_PROMPT = 'dsh> '`; `normalizeTerminalText`.
- **Data flow:** decoded chunk → `push()` → `{ text, prompt, promptTail? }`.
- **Non-obvious design decisions:** the sanitizer is **streaming with split-sequence carry**: a CSI or OSC sequence split across chunks is carried in `pending` rather than leaked. The *owned* OSC `133;D;` marker is recognised (and its printable tail tracked) while every other OSC is discarded.
- **Edge cases / failure handling:** an unterminated control sequence is bounded by `maxPendingBytes` and then discarded; a trailing carriage return is carried across chunks so a line split at `\r\n` is not doubled.
- **Surprising:** full terminal emulation is deliberately deferred — ordinary line output plus the private prompt marker is the supported contract.

### packages/terminal/terminal-bash/src/config.ts
- **Purpose:** Validated configuration for the local PTY backend.
- **Key abstractions:** `Config` / `ResolvedConfig`; `resolveConfig`; `validateConfig`; `DEFAULT_BASH_ARGS`.
- **Data flow:** plugin config → Schemastery defaults → dialect resolution → cross-field validation.
- **Non-obvious design decisions:** emptiness, not just `undefined`, means "dialect default" — because Schemastery materialises an absent optional array as `[]`, a naive `??` would silently drop the dialect defaults. The timing bounds compose: `handoffGraceMs` must be at least one `pollIntervalMs` so a readiness poll always runs inside the grace window, and a nonzero `promptTailGraceMs` must also contain one poll.
- **Edge cases / failure handling:** every numeric field must be a positive safe integer except `promptTailGraceMs`, whose zero is the documented "no extension" value.
- **Surprising:** `maxReadBytes` may not exceed `scrollbackMaxBytes` — a read cap larger than retention is a configuration error.

### packages/terminal/terminal-bash/src/index.ts
- **Purpose:** The shipped shell PTY backend (the `shell` type).
- **Key abstractions:** `BashTerminalBackend`; `childEnvironment`; `PWSH_PROMPT_SETUP`; `startupSession`; the per-owner sandbox-mode fence.
- **Data flow:** `spawn(spec)` → resolve the per-session sandbox policy → confine the shell argv → allocate the terminal → build the session → run the startup sequence → publish.
- **Non-obvious design decisions:** the sandbox-mode fence is attached to the **exact owner** and outlives a provider reload, so a terminal opened with wider access cannot survive a downgrade: a `sandbox/mode` event is **rejected before it commits** while that owner has an open session or a spawn in progress. Pwsh installs its prompt by *writing a function through the session* (it cannot be set from the environment), and startup publishes only on backend `stdin_read` evidence — echoed setup source containing the printable prompt is not readiness.
- **Edge cases / failure handling:** a failed startup is rejected only after the unpublished resources reach quiescence, and a cleanup failure is aggregated into `TerminalBackendCleanupError` rather than claiming success.
- **Surprising:** the bash `PROMPT_COMMAND` **re-asserts `PS1` after the marker**, because bash runs `PROMPT_COMMAND` before rendering each prompt, so a user override would otherwise survive to the next prompt and destroy readiness.

### Boilerplate and small files (one specific line each)

- `packages/shell/shell/package.json` — ESM manifest for the abstract seam; peer-deps `dsh-subprocess`/`dsh-sandbox`/`cordis`, no runtime deps.
- `packages/shell/shell/tsconfig.json` — TS project, `src` → `lib/types`, references cordis/subprocess/sandbox.
- `packages/shell/shell/README.i18n.yaml` — bilingual pairing record with 21 per-section hashes.
- `packages/shell/shell/README.zh.md` — Chinese translation of the seam reference (heading census: 25 headings).
- `packages/shell/shell/tests/render.spec.ts` — 36-line spec pinning the exit-marker parse edges (marker-like output is not a marker).
- `packages/shell/bash-local/package.json` — ESM manifest; peer-deps shell/subprocess/timeout/cordis, runtime dep schemastery.
- `packages/shell/bash-local/tsconfig.json` — TS project with cordis/schemastery/brand/timeout/shell/subprocess references.
- `packages/shell/bash-local/README.i18n.yaml` — bilingual pairing record, 19 section hashes.
- `packages/shell/bash-local/README.zh.md` — Chinese translation of the executor reference (26 headings).
- `packages/shell/pwsh-local/package.json` — ESM manifest for the PowerShell executor.
- `packages/shell/pwsh-local/tsconfig.json` — TS project for the pwsh executor.
- `packages/shell/pwsh-local/README.i18n.yaml` — bilingual pairing record, 20 section hashes.
- `packages/shell/pwsh-local/README.zh.md` — Chinese translation of the pwsh executor reference (25 headings).
- `packages/shell/pwsh-local/tests/settings.spec.ts` — live-config spec: a changed `pwshPath` is re-resolved without remounting.
- `packages/shell/pwsh-local/tests/executor.spec.ts` — ~790-line spec covering path resolution, spawn construction, provider rejection handling and background handles.
- `packages/shell/bash-sandbox/package.json` — ESM manifest; no runtime deps, ships `locale/*.json`.
- `packages/shell/bash-sandbox/tsconfig.json` — TS project for the sandbox executor.
- `packages/shell/bash-sandbox/README.i18n.yaml` — bilingual pairing record, 31 section hashes.
- `packages/shell/bash-sandbox/README.zh.md` — Chinese translation of the sandbox executor reference (37 headings).
- `packages/shell/bash-sandbox/tests/bwrap.e2e.ts` — bwrap e2e: read-only denial, workspace root, background denial, escalated retry.
- `packages/shell/bash-sandbox/tests/landlock.e2e.ts` — Landlock e2e mirror of the bwrap suite.
- `packages/shell/bash-sandbox/tests/seatbelt.e2e.ts` — Seatbelt e2e: EPERM denial text and `BASH_ENV` evaluated only after confinement.
- `packages/shell/bash-sandbox/tests/partial-landlock.spec.ts` — fatal-vs-informational line classification and a child "Permission denied" read as denial, not runner failure.
- `packages/shell/bash-sandbox/tests/foreground-timeout.spec.ts` — preparation-deadline spec: remaining budget passed on, cancellation preserved, timeout first.
- `packages/shell/bash-sandbox/tests/sandbox.spec.ts` — 40+ case unit spec: provider hand-off, fail-closed, per-call policy, denial dialects, per-task facts.
- `packages/shell/bash-sandbox/tests/fixtures/async-confinement-failure.ts` — refusing sandbox + subprocess/terminal tripwire writing `confinement-audit.json`.
- `packages/shell/bash-sandbox/tests/fixtures/pending-confinement.ts` — confinement that settles only on abort, with a process-allocation tripwire.
- `packages/shell/bash-sandbox/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/bash-sandbox/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/pwsh-sandbox/package.json` — ESM manifest for the pwsh confining executor.
- `packages/shell/pwsh-sandbox/tsconfig.json` — TS project for the pwsh sandbox executor.
- `packages/shell/pwsh-sandbox/README.i18n.yaml` — bilingual pairing record, 23 section hashes.
- `packages/shell/pwsh-sandbox/README.zh.md` — Chinese translation of the pwsh sandbox reference (30 headings).
- `packages/shell/pwsh-sandbox/tests/acl.e2e.ts` — Windows ACL e2e: read-only denial with reads allowed, private temp under workspace-write.
- `packages/shell/pwsh-sandbox/tests/foreground-timeout.spec.ts` — pwsh twin of the preparation-deadline spec.
- `packages/shell/pwsh-sandbox/tests/sandbox.spec.ts` — ~45-case unit spec for the helper predicates and fail-closed paths.
- `packages/shell/pwsh-sandbox/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/pwsh-sandbox/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/README.md` — group map listing the ten shell packages with their ctx keys and the profile-layer selection rule.
- `packages/shell/README.i18n.yaml` — bilingual pairing record for the group map, 7 section hashes.
- `packages/shell/README.zh.md` — Chinese translation of the group map.
- `packages/shell/shell-env/package.json` — ESM manifest; peer-deps cordis/app-boot/home-paths/shell/tools.
- `packages/shell/shell-env/tsconfig.json` — TS project for the shell-env registry.
- `packages/shell/shell-env/README.i18n.yaml` — bilingual pairing record, 18 section hashes.
- `packages/shell/shell-env/README.zh.md` — Chinese translation of the managed-environment reference (24 headings).
- `packages/shell/shell-env/tests/shell-env.spec.ts` — registry spec: duplicate/undeclared/non-string rejection and effect-scoped disposal.
- `packages/shell/shell-env/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/shell-env/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/tool-bash/package.json` — ESM manifest; peer-deps shell/shell-env/jobs/sandbox/system-prompt/tools/user-approval/working-directory.
- `packages/shell/tool-bash/tsconfig.json` — TS project for the bash tool with 15 project references.
- `packages/shell/tool-bash/README.i18n.yaml` — bilingual pairing record, 41 section hashes (the largest in the shard).
- `packages/shell/tool-bash/README.zh.md` — Chinese translation of the bash tool reference (37 headings).
- `packages/shell/tool-bash/tests/background-start.spec.ts` — ownership during asynchronous startup: abort, late-process kill, startup failure.
- `packages/shell/tool-bash/tests/background.spec.ts` — job-ring streaming, killed detail merge, foreground promotion and hand-over, registry-refused fallback.
- `packages/shell/tool-bash/tests/integration.spec.ts` — agent-loop integration: session cwd, scrubbed `DSH_*`, non-zero exit as text, background → `job_output`.
- `packages/shell/tool-bash/tests/tools.spec.ts` — ~65-case tool spec: rendering, schema gating, HMR disposal, escalation and approval routing, session-cwd routing.
- `packages/shell/tool-bash/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/tool-bash/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/tool-pwsh/package.json` — ESM manifest for the pwsh tool.
- `packages/shell/tool-pwsh/tsconfig.json` — TS project for the pwsh tool (note `shell-env` listed twice in `references`).
- `packages/shell/tool-pwsh/README.i18n.yaml` — bilingual pairing record, 40 section hashes.
- `packages/shell/tool-pwsh/README.zh.md` — Chinese translation of the pwsh tool reference (36 headings).
- `packages/shell/tool-pwsh/src/background.ts` — pwsh twin of the job adaptation: outcome mapping, lazy pull sources, ring rendering.
- `packages/shell/tool-pwsh/src/render.ts` — `RenderablePwshResult` plus the three pwsh render functions.
- `packages/shell/tool-pwsh/tests/background-start.spec.ts` — pwsh twin of the asynchronous-startup ownership spec (same seven cases).
- `packages/shell/tool-pwsh/tests/background.spec.ts` — pwsh background spec: observed channels, a failing reader warns once, promotion, registry-refused fallback.
- `packages/shell/tool-pwsh/tests/integration.spec.ts` — integration spec: clean exit without a marker, stderr section, timeout marker, abort, background via the real `job_output`.
- `packages/shell/tool-pwsh/tests/loader.spec.ts` — Loader smoke: the composition registers the pwsh surface and renders real results.
- `packages/shell/tool-pwsh/tests/tools.spec.ts` — ~80-case tool spec including a round-trip exit-parse test and the UI presentation cases.
- `packages/shell/tool-pwsh/tests/fixtures/loader/cordis.yml` — minimal Loader composition YAML for the tool-pwsh smoke.
- `packages/shell/tool-pwsh/tests/fixtures/loader/driver.ts` — smoke driver that boots the composition and writes `pwsh-loader-report.json`.
- `packages/shell/tool-pwsh/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/tool-pwsh/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/tool-bash-persistent/package.json` — ESM manifest; exports no `./src/*`.
- `packages/shell/tool-bash-persistent/tsconfig.json` — TS project for the persistent bash tool.
- `packages/shell/tool-bash-persistent/README.i18n.yaml` — bilingual pairing record, 25 section hashes.
- `packages/shell/tool-bash-persistent/README.zh.md` — Chinese translation of the persistent Bash reference (24 headings).
- `packages/shell/tool-bash-persistent/tests/loader-composition.spec.ts` — cwd and environment preserved across calls.
- `packages/shell/tool-bash-persistent/tests/tools.spec.ts` — ~18-case spec: shell reuse, exit paths, surrogate clipping, scrollback assembly, cancellation and spawn rollback.
- `packages/shell/tool-bash-persistent/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/tool-bash-persistent/locale/zh.json` — Chinese UI locale with a description.
- `packages/shell/tool-pwsh-persistent/package.json` — ESM manifest for the persistent pwsh tool.
- `packages/shell/tool-pwsh-persistent/tsconfig.json` — TS project for the persistent pwsh tool.
- `packages/shell/tool-pwsh-persistent/README.i18n.yaml` — bilingual pairing record, 25 section hashes.
- `packages/shell/tool-pwsh-persistent/README.zh.md` — Chinese translation of the persistent PowerShell reference (24 headings).
- `packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` — cwd and environment preserved across calls through a real pwsh composition.
- `packages/shell/tool-pwsh-persistent/tests/readiness-timeline.spec.ts` — spec for the timeline helper's prompt-evidence replay and send-handover timing.
- `packages/shell/tool-pwsh-persistent/tests/readiness-timeline.ts` — 354-line diagnostic helper (first 120 lines read): records every chunk, poll, write and spawn with timestamps.
- `packages/shell/tool-pwsh-persistent/tests/tools.spec.ts` — ~19-case spec: shell reuse, echo stripping, exit paths, clipping, cancellation and spawn rollback.
- `packages/shell/tool-pwsh-persistent/locale/en.json` — English UI locale, `meta.title` only.
- `packages/shell/tool-pwsh-persistent/locale/zh.json` — Chinese UI locale with a description.
- `packages/subprocess/README.md` — group map for the subprocess family.
- `packages/subprocess/README.i18n.yaml` — bilingual pairing record for the group map, 7 section hashes.
- `packages/subprocess/README.zh.md` — Chinese translation of the group map.
- `packages/subprocess/subprocess/package.json` — ESM manifest for the abstract seam; exports `./control`.
- `packages/subprocess/subprocess/tsconfig.json` — TS project with cordis/http-proxy/launch-environment references.
- `packages/subprocess/subprocess/tsdown.config.ts` — tsdown config emitting `index` and `control` entries as ESM.
- `packages/subprocess/subprocess/README.i18n.yaml` — bilingual pairing record, 23 section hashes.
- `packages/subprocess/subprocess/README.zh.md` — Chinese translation of the seam reference (26 headings).
- `packages/subprocess/subprocess/src/control.ts` — `openInheritedControlChannel()`: consumes the private marker and opens a byte-mode duplex at fd 7.
- `packages/subprocess/subprocess/tests/control.spec.ts` — the marker is consumed and the descriptor opened exactly once.
- `packages/subprocess/subprocess/tests/egress.spec.ts` — a child Node honours the proxy the user exported, including `ALL_PROXY`-only and per-scheme filling.
- `packages/subprocess/subprocess/tests/service.spec.ts` — seam spec: registration, duplicate-registration throw, and the case-insensitive env scrub.
- `packages/subprocess/subprocess-local/package.json` — ESM manifest with runtime deps koffi 3.1.1 and node-pty 1.2.0-beta.15, a `postinstall` chmod script, and separate `./runner` / `./output` exports.
- `packages/subprocess/subprocess-local/tsconfig.json` — TS project with cordis/subprocess/win32-process/timeout/lazy-require references.
- `packages/subprocess/subprocess-local/tsdown.config.ts` — tsdown config emitting `index`, `runner` and `output` entries as ESM.
- `packages/subprocess/subprocess-local/README.i18n.yaml` — bilingual pairing record, 22 section hashes.
- `packages/subprocess/subprocess-local/README.zh.md` — Chinese translation of the provider reference (25 headings).
- `packages/subprocess/subprocess-local/scripts/ensure-spawn-helper.mjs` — postinstall `chmod 0755` on node-pty's prebuilt `spawn-helper`.
- `packages/subprocess/subprocess-local/src/bin.ts` — thin runner entry; exits 127 when no private selector was supplied.
- `packages/subprocess/subprocess-local/src/control-spawn.ts` — parent-side control pipe setup; rejects a caller-authored marker.
- `packages/subprocess/subprocess-local/src/linux-execve.ts` — lazy libc `execve`/`fcntl` through koffi, clearing `FD_CLOEXEC` on fds 0-2 (and 7).
- `packages/subprocess/subprocess-local/src/managed-owner.ts` — `BoundProcessOwner` interface plus `waitWithAbort()`, the shared cancellable range wait.
- `packages/subprocess/subprocess-local/src/windows-inspector.ts` — Windows Toolhelp32 inspection via koffi: lazy snapshot, creation-time identity, wait-state liveness, taskkill signalling.
- `packages/subprocess/subprocess-local/src/windows-job.ts` — Windows Job launch through the private IPC runner with per-spawn capability re-probe.
- `packages/subprocess/subprocess-local/tests/control.spec.ts` — paused endpoint disposal, caller-endpoint closure, absent channel, marker rejection.
- `packages/subprocess/subprocess-local/tests/fixtures/control-child.ts` — fixture child echoing binary bytes over the inherited fd-7 channel.
- `packages/subprocess/subprocess-local/tests/fixtures/hold-linux-bootstrap.ts` — fixture that keeps the launch request unconsumed until the parent kills it.
- `packages/subprocess/subprocess-local/tests/fixtures/managed-tree.ts` — fixture spawning a TERM/SIGHUP-ignoring descendant and publishing both pids atomically.
- `packages/subprocess/subprocess-local/tests/fixtures/process-exit-host.ts` — fixture host that exits directly, via uncaught exception, via unhandled rejection, or by disposing the fiber.
- `packages/subprocess/subprocess-local/tests/linux-execve.spec.ts` — the two libc failure paths (unreadable flags, failed close-on-exec clear).
- `packages/subprocess/subprocess-local/tests/linux-scope-selector.spec.ts` — the selector consults only the observations each verdict needs.
- `packages/subprocess/subprocess-local/tests/linux-scope.spec.ts` — ~1100-line spec: establishment vs absence, poll backoff, kill-failure proof, malformed manager state.
- `packages/subprocess/subprocess-local/tests/local.spec.ts` — ~1400-line provider spec: host-exit finalisation ordering, executable resolution, scope selection and re-probe.
- `packages/subprocess/subprocess-local/tests/native-containment.spec.ts` — Linux native e2e: abort before bootstrap consumption, setsid descendant termination, no replay on `ENOENT`/`EACCES`.
- `packages/subprocess/subprocess-local/tests/native-windows.spec.ts` — Windows native e2e: hidden console windows, raw stdin writability, null-device stdin semantics.
- `packages/subprocess/subprocess-local/tests/process-exit.spec.ts` — normal terminate-and-join disposal preserved and the exit listener removed.
- `packages/subprocess/subprocess-local/tests/process-inspector.spec.ts` — inspector spec: unreadable `/proc`, zombie groups, exact kernel-ABI stdin waits, macOS identity fencing.
- `packages/subprocess/subprocess-local/tests/shell-activity-files.spec.ts` — only fresh complete records count; unsupported launches untouched; private files removed.
- `packages/subprocess/subprocess-local/tests/shell-activity.spec.ts` — busy detection for silent work and background jobs; `vared` and stopped jobs are not idle.
- `packages/subprocess/subprocess-local/tests/spawn-runner-built.e2e.ts` — executes the source runner entry through the provider-owned core.
- `packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts` — ~1000-line runner spec: strict protocol, bootstrap env hygiene, NUL validation, Job runner ownership.
- `packages/subprocess/subprocess-local/tests/spawn.spec.ts` — ~1600-line spawn spec: stdio, env tombstones, escalation, and every `OutputCollector` failure path.
- `packages/subprocess/subprocess-local/tests/terminal.spec.ts` — ~800-line terminal spec: backpressure, TERM/KILL tiers, PID-reuse refusal, Windows Ctrl-C and taskkill tiers.
- `packages/subprocess/subprocess-local/tests/windows-inspector.spec.ts` — lazy enumeration, children-first tree walk, cycle termination, pseudo foreground group.
- `packages/subprocess/subprocess-local/tests/windows-job.spec.ts` — capability re-probe per spawn, strict runner IPC, direct-outcome vs range-quiescence mapping.
- `packages/subprocess/subprocess-local/locale/en.json` — English UI locale, `meta.title` only.
- `packages/subprocess/subprocess-local/locale/zh.json` — Chinese UI locale with a description.
- `packages/subprocess/win32-process/package.json` — ESM manifest for the Win32 library; runtime dep koffi 3.1.1, no Cordis service.
- `packages/subprocess/win32-process/tsconfig.json` — TS project with cordis/lazy-require references.
- `packages/subprocess/win32-process/README.i18n.yaml` — bilingual pairing record, 13 section hashes.
- `packages/subprocess/win32-process/README.zh.md` — Chinese translation of the Win32 library reference (17 headings).
- `packages/subprocess/win32-process/src/abi.ts` — Win32 constants and x64 layout sizes/offsets.
- `packages/subprocess/win32-process/src/errors.ts` — `Win32Error` carrying the failing API name and exact error code.
- `packages/subprocess/win32-process/src/index.ts` — barrel re-export of the ABI, errors, bindings and process primitives.
- `packages/subprocess/win32-process/src/koffi.ts` — one-line lazy require of Koffi's CommonJS entry.
- `packages/subprocess/win32-process/tests/ffi.spec.ts` — x64 structure sizes match, NULL out-parameters handled, exact Win32 error formatted.
- `packages/subprocess/win32-process/tests/fixtures/console-state.ts` — fixture reporting the inherited console's attachment and visibility from a real Windows child.
- `packages/subprocess/win32-process/tests/ordinary-process.spec.ts` — suspended create, Job assignment, resume, carrier resolution, Job accounting.
- `packages/subprocess/win32-process/tests/process-allocation-failure.spec.ts` — every native allocation failure frees its memory.
- `packages/subprocess/win32-process/tests/process-failure-paths.spec.ts` — every pipe/Job/inheritance/resume failure closes exactly the handles it owns.
- `packages/subprocess/win32-process/tests/process.spec.ts` — restricted-token spec: control-carrier inheritance, create-assign-resume order, error capture before cleanup changes last-error.
- `packages/subprocess/win32-process/tests/quote.spec.ts` — `quoteArg()` builds one command line that round-trips to the original argv.
- `packages/terminal/README.md` — group map: the session service and the shell backend.
- `packages/terminal/README.i18n.yaml` — bilingual pairing record for the group map, 7 section hashes.
- `packages/terminal/README.zh.md` — Chinese translation of the group map.
- `packages/terminal/terminal/package.json` — ESM manifest for the `ctx.terminals` seam; peer-deps agent/brand/cordis.
- `packages/terminal/terminal/tsconfig.json` — TS project with cordis/agent/brand references.
- `packages/terminal/terminal/README.i18n.yaml` — bilingual pairing record, 25 section hashes.
- `packages/terminal/terminal/README.zh.md` — Chinese translation of the terminal service reference (27 headings).
- `packages/terminal/terminal/src/types.ts` — PTY contracts, wait reasons, signal set, scrollback page shape, branded session id.
- `packages/terminal/terminal/tests/service.spec.ts` — ~30-case spec: registry disposal, owner fencing, name reservations, cancellation preservation, disposal aggregation.
- `packages/terminal/terminal/locale/en.json` — English UI locale, `meta.title` only.
- `packages/terminal/terminal/locale/zh.json` — Chinese UI locale with a description.
- `packages/terminal/terminal-bash/package.json` — ESM manifest; runtime deps `@xterm/headless`, schemastery, lazy-require, pwsh-local.
- `packages/terminal/terminal-bash/tsconfig.json` — TS project for the shell backend with eleven project references.
- `packages/terminal/terminal-bash/README.i18n.yaml` — bilingual pairing record, 29 section hashes.
- `packages/terminal/terminal-bash/README.zh.md` — Chinese translation of the shell backend reference (30 headings).
- `packages/terminal/terminal-bash/tests/config.spec.ts` — bound validation, handoff-grace floor, dialect resolution incl. the empty-array-as-unset rule.
- `packages/terminal/terminal-bash/tests/index.spec.ts` — backend spec: startup rollback, confined argv wrapping, pwsh prompt bootstrap, sandbox-mode fence.
- `packages/terminal/terminal-bash/tests/local.spec.ts` — local e2e: cwd/environment persistence, PS1 restoration, foreground signalling, UTF-8 pinning.
- `packages/terminal/terminal-bash/tests/sanitize.spec.ts` — sanitizer spec: split CSI/OSC removal, CR normalisation, bounded unterminated sequences.
- `packages/terminal/terminal-bash/tests/session-buffer.spec.ts` — incremental retention: exact tail across the 4 MiB limit, split UTF-8, surrogate pairs.
- `packages/terminal/terminal-bash/tests/session.spec.ts` — ~1350-line spec: readiness tiers, prompt-tail grace, cancellation ownership, protocol-reply draining.
- `packages/terminal/terminal-bash/locale/en.json` — English UI locale, `meta.title` only.
- `packages/terminal/terminal-bash/locale/zh.json` — Chinese UI locale with a description.

---

## Ideas worth stealing

- **Resolve the request into an explicit spec before anything runs, and never re-default inside the executor** — `packages/shell/shell/src/types.ts:61` (the optional `ShellExecRequest`) vs `packages/shell/shell/src/types.ts:111` (the fully-resolved `ShellExecSpec`) and `packages/shell/shell/src/index.ts:84` (`abstract resolve(request): ShellExecSpec`). *Why it matters for August:* August's tool layer currently resolves budgets in several places; a single request→spec step makes caps, defaults and the "who owns this value" question answerable in one file, and makes a hidden fallback structurally impossible.

- **Classify timeout vs abort as mutually exclusive first causes, not two booleans** — `packages/shell/bash-local/src/index.ts:216` (one fused `deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')`) and `packages/shell/bash-local/src/index.ts:218` (the `classify` closure that returns `timedOut` XOR `aborted`). *Why it matters for August:* the repo's own rule ("a timeout and an abort racing before process close report the single first-abort cause, not both") is exactly what August's budget ladder and `_retryWaitRefusalMs` need: the tool must be able to say *which rung fired*, and August's `turn_end {reason}` vocabulary already has distinct `cap`/`budget`/`stall-stop` values that depend on it.

- **A spawn that never produced a process must still have a readable stderr** — `packages/shell/bash-local/src/index.ts:291` (a synthetic `observedStderr` reader that serves the stage-neutral note) and `packages/shell/bash-local/src/index.ts:342` (the consuming `readOutput()` folds the note in exactly once). *Why it matters for August:* August's `run_command` currently has nothing to show the model when the *spawn itself* fails; this pattern gives every reader — the model's consuming cursor and any UI observer at its own offset — the same failure text, and guarantees it is delivered once.

- **Offer two readers over one stream: a consuming cursor for the model and offset readers for observers** — `packages/shell/shell/src/types.ts:23` (`ShellObservedStreams`) and `packages/subprocess/subprocess/src/types.ts:142` (`SubprocessOutputReader.readFrom(fromByte)` — "offsets are whole-stream byte coordinates owned by the caller, so independent readers cannot consume one another's output"). *Why it matters for August:* August renders the same command output in the transcript card, the task list and the tool result; the cursor-free reader model is what lets the Web UI tail a live job without stealing bytes from the model's `job_output` read.

- **Bounded tail-keep output with a best-effort, hardened spill file** — `packages/subprocess/subprocess-local/src/output.ts:160` (`push()` keeps a byte-exact tail), `packages/subprocess/subprocess-local/src/output.ts:204` (`openSync(file, 'wx', 0o600)` — `O_EXCL`, owner-only, random name under a `0700` per-process dir) and `packages/subprocess/subprocess-local/src/output.ts:126` (the stated rationale: "errors and final results cluster at the end of command output; the spill file covers the head"). *Why it matters for August:* August truncates long tool output and needs somewhere to put the rest; this gives a tail-not-head policy (right for errors and final results), a recovery path the model can be told about, and — critically — a failure mode that never breaks the command, because the write happens inside a stream listener.

- **Promote a timed-out foreground command into a background job instead of killing it, and hand the output over mid-stream** — `packages/shell/tool-bash/src/index.ts:340` (the promotion branch: the command keeps running as the job it already was) and `packages/shell/tool-bash/src/render.ts:81` (the `[still running after <timeoutMs>ms; moved to background job <id>]` marker plus the `job_output`/`job_kill` hand-off guidance). *Why it matters for August:* August's `run_command` kills long builds at the tool timeout, throwing away the work; this turns the timeout into a *transition* and gives the model a job id it can poll — the model-facing cost is one extra line, and the work survives.

- **Register the prompt guidance as an independent prompt section, not as schema prose** — `packages/shell/tool-bash/src/index.ts:251` (`ctx.systemPrompt.section({ name: 'tool:bash', order: …, text: 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.' })`). *Why it matters for August:* a scoped tool restriction can hide the schema without removing the habit instruction, and the section's text is prefix-stable (the README's KV-cache section records it as such) so it does not invalidate cache reuse.

- **Teach the model the *platform's* failure dialect in the tool description** — `packages/shell/tool-pwsh/src/index.ts:141` (the ConstrainedLanguage rules: "`[System.IO.*]::`, `[math]::`, `Add-Type`, COM objects, and reflection fail with 'only core types' errors") and `packages/shell/tool-pwsh/src/index.ts:145` (the named-pipe EPERM boundary, with the explicit instruction "do not retry the command another way — escalate the exact command once"). *Why it matters for August:* on Windows, a model that does not know about ConstrainedLanguage retries `Add-Type` forever and reads each failure as a command bug; naming the boundary in the description converts a retry loop into a single escalation.

- **Distinguish "the policy denied it" from "the enforcement runner is broken" — and let runner failure outrank denial** — `packages/shell/bash-sandbox/src/index.ts:120` (the runner-failure classification runs *before* the denial classification) and `packages/shell/pwsh-sandbox/src/helpers.ts:84` (`classifyRunnerFailure`: a nonzero exit, an optional exit-code gate, and a fatal signature on one stderr line after exact informational lines are excluded). *Why it matters for August:* August has a marker table where a refusal must read as a refusal; if a broken runner's error text also matches a denial marker, the model retries a command that will never run. The precedence rule is cheap and the reason is stated.

- **Fail closed rather than silently degrade** — `packages/shell/bash-sandbox/src/index.ts:89` (a confined mode with no usable runner throws `SANDBOX_UNAVAILABLE`; it never runs unconfined) and `packages/subprocess/subprocess-local/src/index.ts:260` (the fallback path is used only when the native path was never selected, and the weaker containment is *announced once* with the platform-specific reason). *Why it matters for August:* "we could not enforce the sandbox" and "the sandbox said no" are different facts; conflating them is how a harness silently runs a command with more authority than the user granted.

- **Fence every signal on a start-time identity, never on the PID** — `packages/subprocess/subprocess-local/src/process-inspector.ts:9` (`ProcessIdentity = { pid, started }`) and `packages/subprocess/subprocess-local/src/process-inspector.ts:363` (`signalProcess` rechecks `isAlive(identity)` immediately before delivering). *Why it matters for August:* August's teardown kills process trees; a recycled PID means killing an unrelated process. The identity fence is ~10 lines and removes an entire class of "we killed the wrong thing" incidents.

- **Detect command completion in a PTY with unique markers, and reset rather than repair when the state is uncertain** — `packages/shell/tool-bash-persistent/src/index.ts:66` (`markers()` — a fresh `randomUUID` nonce per command) and `packages/shell/tool-bash-persistent/src/index.ts:86` (`wrapCommand()` — one physical line, `eval -- $'…'`, exit status captured in `$?`); `packages/shell/tool-bash-persistent/src/index.ts:19` (`SHELL_RESET_MESSAGE` — "the next bash call starts from the workspace with a fresh current directory and environment"). *Why it matters for August:* a persistent shell has no exit-code API; the marker trick is how you get one, and "reset, never repair" is the right policy when a shell's state is unknown — a half-known shell is worse than a clean one, and the model is told the truth instead of inheriting a stale cwd.

- **Serialise calls per owner into one stateful resource** — `packages/shell/tool-bash-persistent/src/index.ts:402` (`serialized(owner, operation)` — a per-agent promise chain so two calls cannot interleave in one shell). *Why it matters for August:* August's subagents and the parent share a working directory; any per-session resource (a shell, a REPL, a dev server) needs the same queue, and the queue must be per-owner so two agents do not serialise against each other.

- **Readiness is a set of bounded tiers, and "unknown" is never "idle"** — `packages/terminal/terminal-bash/src/session.ts:549` (`pollReadiness`: exact stdin wait → prompt marker + printable tail → silence) and `packages/terminal/terminal-bash/src/session.ts:593` (the `promptTailGraceMs` rule: "the marker and its tail are written by the same render, so its absence within the bound is a delivery delay rather than an absent prompt"). *Why it matters for August:* August's terminal and long-running-tool surfaces need the same shape — a cheap exact tier when available, a marked tier when not, silence as the last resort, and an absolute timeout that always bounds the wait. The "unknown is never idle" rule is what stops the harness from declaring a still-busy command finished.

- **Distinguish a stopped process from a failed one, in the model's own words** — `packages/shell/tool-bash/src/render.ts:56` (`[stopped: <reason>]` is emitted *before* the signal marker, "a kill from outside the call (the human stopping its job) is not a command failure: the reason tells the model not to retry"). *Why it matters for August:* August lets a human stop a running job; without this marker the model reads a human's cancellation as a command failure and retries work the user deliberately cancelled.

- **A per-section hash record keeps a bilingual doc pair in lockstep** — `packages/shell/tool-bash/README.i18n.yaml:1` (the header: "per heading section, a hash of its English and Chinese blocks outside code blocks and generated regions") with the re-record command `pnpm run verify-translation-pairing --write`. *Why it matters for August:* August is bilingual; a per-section hash lets a static gate prove the two sides correspond without a prose diff, and the section keys themselves are a machine-readable map of the document's structure.

- **A tool's declared arguments are a contract, not a convenience** — `packages/shell/tool-bash/src/index.ts:73` (`validateBashArgs`: a blank command, a blank description, a non-positive `timeoutMs`, and the escalation pairing are all rejected with stable messages) and `packages/shell/tool-bash/src/index.ts:368` (the `output.schema` `oneOf` with `additionalProperties: false` for each of the three result shapes). *Why it matters for August:* August's tool schemas are the model's contract; a closed `oneOf` result schema plus named, stable validation messages is how a model learns what a failure means without a second turn.

---

## Files skipped (with reasons)

**None.** All 233 files in this shard were opened and read. No file was skipped, and no file was marked `skipped` in the ledger. Reading depth differed by file class, and the differences are recorded per file in the ledger and in the Uncertainties below:

- Source files (56): read **line by line in full** — except `packages/shell/tool-pwsh/src/index.ts`, `packages/shell/tool-pwsh/src/render.ts`, `packages/shell/tool-pwsh/src/background.ts` and `packages/shell/tool-pwsh-persistent/src/index.ts`, which were read as a **unified diff against their bash twins** (269, 51, 19 and ~150 diff lines respectively), which yields the same content because the twins are byte-identical outside the marked regions.
- `packages/shell/tool-pwsh-persistent/tests/readiness-timeline.ts` (354 lines): read lines 1-120 in full; the remainder is the timeline formatting and replay implementation that the file's own doc comment describes.
- Test files (73): the full source of `packages/shell/bash-local/tests/executor.spec.ts`, `packages/shell/bash-local/tests/settings.spec.ts`, `packages/shell/shell/tests/render.spec.ts`, `packages/shell/shell/tests/service.spec.ts` and `packages/shell/shell-env/tests/shell-env.spec.ts` was read line by line. For the remaining 68 spec files I read a **complete `describe`/`it`/`test` title census with line numbers** plus the fixture files in full — i.e. the behavioural contract of each suite, not every assertion body.
- `README.md` (18 English, one per package/group): read in full.
- `README.zh.md` (18): read the front matter, the summary and a **complete heading census** (so the section structure is known); the translated prose body was not read line by line. Section parity is independently guaranteed by the `.i18n.yaml` hash records.
- `README.i18n.yaml` (18): read the header, the complete section-key list and the hash count for each; the hash *values* were read in full only for `packages/shell/README.i18n.yaml` and `packages/shell/shell/README.i18n.yaml`.
- `package.json` (15), `tsconfig.json` (15), `locale/*.json` (20), `tsdown.config.ts` (2): read as structured field dumps (name/version/exports/deps/files/scripts, or the raw JSON where tiny).
- `packages/subprocess/win32-process/verify/abi-probe.cpp`: read in full (63 lines).

---

## Uncertainties

- **Test assertion bodies were not read line by line.** For 68 of the 73 test files I read the complete test-title census plus the source, not every `expect(...)`. I therefore know *what* each suite pins but not the exact fixture values, tolerances or mock shapes behind each assertion. Where a behaviour mattered to a note above (e.g. the first-cause classification, the promotion hand-over, the readiness tiers), I read the corresponding production source in full and cross-checked it against the test titles.
- **The Chinese READMEs were not read line by line.** I verified structure (front matter, heading census, `.i18n.yaml` section-key parity) rather than reading every translated sentence. A divergence that keeps the same heading structure but changes the *meaning* of a paragraph would not have been caught by what I read.
- **The `.i18n.yaml` hash values** were read in full for two files and by count for the other sixteen; I did not recompute any hash, so I cannot confirm that any pair is currently *in* sync — only that the record exists and names the sections.
- **Cross-package contracts I could not establish from this shard.** The shard imports `@deepseek-ai/dsh-timeout` (`deadline`, `timeoutOf`, `clampTimeout`, `MAX_TIMER_DELAY_MS`), `@deepseek-ai/dsh-sandbox` (`SandboxProvider`, `confine`, `matchesSignature`, `ESCALATION_TARGETS`, `approveEscalation`, the denial/escalation markers), `@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-output-retention` and `@deepseek-ai/dsh-working-directory`. Their definitions live in other shards; I read only their *use* here, so e.g. exactly how `deadline()` fuses a caller signal with a timeout, and how `approveEscalation()` sequences the approval door, are outside what I read.
- **`@deepseek-ai/dsh-http-proxy` and `proxyEnvironmentForChild()`** are referenced by `scrubbedParentEnv` but are outside this shard; I could not confirm which proxy variable names the child overlay restores beyond what the function's own comment says.
- **The Win32 native paths were not executed.** `packages/subprocess/win32-process` binds `kernel32.dll`/`advapi32.dll` through koffi; I read the code and the ABI probe but could not verify any of it against a live Windows host (the clone is read-only and nothing was executed). The `verify/abi-probe.cpp` probe was read, not compiled.
- **Two `ToolRuntime` behaviours are asserted by the persistent-tool suites but owned elsewhere:** "after cleanup settles, ToolRuntime publishes `Error: tool call aborted` with code `ABORTED`" and "a queued cancelled call sends no command" are stated in `packages/shell/tool-bash-persistent/README.md` and the pwsh twin; the runtime itself is not in this shard.
- **The `tool-bash` "replay exit pills" residual** (`packages/shell/tool-bash/README.md`, Known Limitations) is a real known defect: output whose final line is exactly `[exit code: N]` is parsed as the marker on replay. I confirmed the parse behaviour in `packages/shell/shell/src/render.ts:37` and the spec that pins it, but did not confirm the replay path itself, which lives in the Web client.
