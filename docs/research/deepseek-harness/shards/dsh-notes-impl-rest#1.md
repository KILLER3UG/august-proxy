# deepseek-harness / dsh-notes-impl-rest#1

## Shard shape

This shard is **the entire `implemented` Agent-Note corpus of the deepseek-harness repo** — 257 files, nothing else. It is not source code: it is 85 *shipped-decision records*, each stored as a triplet of an English note (`.md`), a Chinese translation (`.zh.md`) and a bilingual-pairing sidecar (`.i18n.yaml`, one SHA-64 hash per heading section for the EN and ZH blocks), plus two index files (`AGENTS.md`, `CLAUDE.md`). The notes are grouped by lifecycle into `bug-fix/` (11 notes), `feature/` (40 notes) and `process/` (34 notes), and each follows the same section skeleton — Problem → Decision → Alternatives considered → Consequences → Verification/Testing — so the corpus reads like a design-decision log rather than documentation. What makes it valuable for a harness study is that the "Decision" sections are written as *mechanisms with named symbols and defaults*, not as prose: `SystemPromptProjection.project()`, `isConcurrencySafe(args)`, `ctx.approval`, `ToolRuntime.restrict()`, `SessionWriteLease`, `PromptAssembly.tools`, `agent/pre-step`, `workspace/session-activity`. The `feature/` notes are the agent-loop core (PTC / code-mode, parallel tool dispatch, subagent activations and agent teams, the approval seam, context-form vocabulary, in-history system-prompt replacement); the `bug-fix/` notes are the *hardened* edges of the same loop (session-open read races, PTY prompt readiness on Windows, background-shell display, job lifecycle journaling); the `process/` notes are almost entirely release/CI/packaging discipline (npm publication sequences, CI failover switches, persistence-schema review, build-speed work budgets) plus three that read directly onto harness engineering (session reader-compatibility versioning, the frozen-note archive policy, and the no-`unknown`-casts rule).

### Lens coverage in this shard

| Lens | Where it lives in this shard |
|---|---|
| agent loop and tool-calling flow | `feature/2026-06-15-ptc.md`, `feature/2026-07-20-ptc-typed-tool-returns.md`, `feature/2026-07-10-parallel-tool-call-execution.md` (the whole dispatch/commit-cursor model) |
| reasoning / thinking content | `feature/2026-09-07-deepseek-messages-adapter.md` (thinking signatures, `output_config.effort`, `ReplayEnvelope`); `feature/2026-09-02-in-history-system-prompt-replacement.md:50` (Claude's thinking-signature binding is what makes a changed prompt fatal) |
| prompt construction & cache strategy | `feature/2026-09-02-in-history-system-prompt-replacement.md` (append-instead-of-rewrite), `bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.md` (volatile values out of the prompt), `feature/2026-08-05-context-form-vocabulary.md` |
| context-window management | `feature/2026-06-15-ptc.md:112` (result elision vs. code-mode), `feature/2026-07-20-ptc-typed-tool-returns.md` (intermediate values never enter context; only the outer value does) |
| model-specific adaptations | `feature/2026-09-07-deepseek-messages-adapter.md` (DeepSeek over the Anthropic Messages wire), `feature/2026-10-15-deepseek-search-fetch-api.md` (separate Search/Fetch bases), `feature/2026-08-24-user-authorized-subagent-model-routes.md` |
| memory / learning | Thin in this shard — no recall/learning note here; the closest is `feature/2026-08-05-context-form-vocabulary.md` (durable `MessageSource` shape) and `bug-fix/2026-09-30-job-session-lifecycle.md` (durable lifecycle facts) |
| subagent / parallel execution | `feature/2026-07-28-continuable-subagent-conversations.md`, `feature/2026-07-12-subagent-persona-tool-filter-and-depth.md`, `feature/2026-08-05-agent-teams.md`, `feature/2026-09-20-spawn-agent-preset-selection.md` |
| tool-call reliability | `feature/2026-07-06-approval-seam.md` (fail-closed opt-out), `feature/2026-08-28-auto-review.md` + `feature/2026-09-24-auto-review-user-approval-fallback.md` (denial vs failure), `feature/2026-08-31-cross-process-session-write-lease.md` |
| UI / UX | `feature/2026-09-04-right-sidebar-docking-infrastructure.md`, `feature/2026-09-16-sidebar-browser.md`, `feature/2026-09-24-session-inspector.md`, `feature/2026-08-05-context-form-vocabulary.md`, `bug-fix/2026-09-15-client-session-blank-reconciliation.md`, `bug-fix/2026-10-10-background-shell-command-display.md` |
| config | `feature/2026-09-20-config-schema-dump-validation-policy.md`, `feature/2026-08-24-user-authorized-subagent-model-routes.md`, `bug-fix/2026-09-27-pwsh-prompt-tail-grace.md` (a validated numeric field whose zero is a documented value) |
| evals / testing | `feature/2026-07-20-ptc-typed-tool-returns.md` (real-worker integration tests for handle workflows), `process/2026-10-08-session-reader-compatibility-review.md`, `process/2026-09-28-dual-release-install-layout-work-budget.md`, `process/2026-10-12-local-gate-speedups.md` |

---

## Per-file notes

### .agents/notes/implemented/AGENTS.md
- Purpose: lifecycle rules for the `implemented/` note corpus.
- Key abstractions: "keep a shipped note current in the same change"; "delete the complete triplet through `dsh-archive-agent-notes`"; "a reversal of the decision requires a NEW note plus a cross-link".
- Data flow: n/a (policy).
- Non-obvious design decisions: explicitly forbids using archive as a place to rewrite the *decision* — only the factual realization may be updated in place (line 11-13).
- Edge cases / failure handling: a fully superseded old note may be deleted only through the consolidation rule in the parent README.
- Surprising: the corpus treats its own notes as live obligations (paths, symbols, defaults, translations, code fences) — a note is not a historical record but a spec.

### .agents/notes/implemented/CLAUDE.md
- One line: a 9-byte pointer whose entire content is the string `AGENTS.md`, so Claude-style tools find the same agent instructions.

### .agents/notes/implemented/bug-fix/2026-09-06-packed-install-private-npm-cache.md
- Purpose: stop the packed-install release verifier from growing the shared runner's ambient npm cache.
- Key abstractions: `--cache <consumerRoot>/.npm-cache` passed to that one npm invocation; the existing `finally` removes cache + consumer together.
- Data flow: verifier → its own npm install (private cache) → consumer removed on success, install failure, or executable failure.
- Non-obvious design decisions: "the explicit argument overrides npm environment and user-configuration cache settings without changing the environment of the installed executable" (line 13) — the cache is scoped to the invocation, not the machine.
- Edge cases / failure handling: a forced termination that skips `finally` still leaves the cache; no crash-recovery cleanup is added.
- Surprising: it *accepts* repeated downloads as the price of ownership rather than adding a retention policy.

### .agents/notes/implemented/bug-fix/2026-09-06-packed-install-private-npm-cache.zh.md
- Chinese twin of the packed-install cache note; its 问题/决策 carry the `--cache` ownership argument and the three rejected alternatives verbatim in Chinese.

### .agents/notes/implemented/bug-fix/2026-09-06-packed-install-private-npm-cache.i18n.yaml
- Hash sidecar: six EN/ZH heading-block hashes (`…/problem`, `/decision`, `/alternatives-considered`, `/consequences`, `/verification`) for the packed-install note, plus the `verify-translation-pairing --write` command in the header comment.

### .agents/notes/implemented/bug-fix/2026-09-15-authenticated-browser-host-preferences.md
- Purpose: make Web user preferences persist for every authenticated browser, not only loopback pages.
- Key abstractions: one `settings.describe` mirror; one `ctx.configForms.get(entryId)` per namespace; the `settings.mutate` write path; mirror state space `idle | loading | ready`.
- Data flow: browser → Connection (token-authenticated) → Host settings document → namespace revision `expectedRevision` on each form write.
- Non-obvious design decisions: "Locality selects nothing" — `remote.$host` locality facts become request-routing evidence, not a store selector, because browser token auth is the real identity boundary (line 13).
- Edge cases / failure handling: concurrent writers on one document resolve through the per-namespace `expectedRevision`; a form reports `unavailable` only for a namespace the Host never registered.
- Surprising: exactly one locality-dependent UI element survives — the **Open configuration file** button, and only for loopback pages, because it is a presentation choice about the native editor, not a persistence rule.

### .agents/notes/implemented/bug-fix/2026-09-15-authenticated-browser-host-preferences.zh.md
- Chinese twin; its 问题 states that the old locality gate made every Host-backed row inert on trusted remote and public deployments.

### .agents/notes/implemented/bug-fix/2026-09-15-authenticated-browser-host-preferences.i18n.yaml
- Hash sidecar for the browser-preferences note's six heading blocks (root anchor `/agent-note-share-host-preferences-with-every-authenticated-browser`).

### .agents/notes/implemented/bug-fix/2026-09-15-client-session-blank-reconciliation.md
- Purpose: stop a later `session.list` (reporting `blank: true`) from undoing the Client's "accepted → real session" row conversion.
- Key abstractions: a private `engagedSessions` set in the Session Manager, keyed by Session id; `summary.blank && !engagedSessions.has(sessionId)`.
- Data flow: prompt acceptance → `onEngaged` → Manager set + list row + resident Session by id → survives refresh, reconnect and object replacement.
- Non-obvious design decisions: engagement is *display memory*, explicitly "not proof that a turn started, work remains queued, or a message reached durable storage", and is not persisted across a page reload (line 29).
- Edge cases / failure handling: a rejected prompt records no engagement; a baseline list predating removal cannot restore the observation; late acceptance cannot recreate a removed row; Manager disposal clears the set.
- Surprising: "A `running: true` status, addition, or list baseline also records engagement" — three different signals collapse into one boolean.

### .agents/notes/implemented/bug-fix/2026-09-15-client-session-blank-reconciliation.zh.md
- Chinese twin; its 问题 names the exact symptom (a `session.list` response undoing the conversion) and the reconnect trigger.

### .agents/notes/implemented/bug-fix/2026-09-15-client-session-blank-reconciliation.i18n.yaml
- Hash sidecar for the blank-reconciliation note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-20-session-open-read-coordination.md
- Purpose: stop auxiliary RPCs from competing with the main conversation for a cold Session's log read.
- Key abstractions: `SessionPersistence.identity` — a `Symbol('sessionPersistence')` created once per service instance (line 19); cache key = (session id, `persistence.identity`, `stat().revision`).
- Data flow: `session.follow` + composer prewarm + `skills/list` / `commands/list` / `goals/get` / `fileReferences/list` / `sessionReferenceResolver/candidates` → all now wait on `sessions.using()` before firing.
- Non-obvious design decisions: Cordis can hand back *different proxy objects* for the same service, so reference equality misidentifies the producer; a service-owned Symbol survives the proxy and a replacement instance gets a different one. The identity never enters Session headers, events or persisted files.
- Edge cases / failure handling: the identity fixes *false invalidation after completion*, it does not merge concurrent cold reads; `ready` means the open *settled*, not that it succeeded — consumers additionally require `openState === 'open'` and send no RPC after a failed open.
- Surprising: the Goal reader additionally re-checks that its captured binding was not replaced, and logs rejected reads without clearing existing display state.

### .agents/notes/implemented/bug-fix/2026-09-20-session-open-read-coordination.zh.md
- Chinese twin; its 问题 states the proxy-identity trap and the auxiliary-RPC race in Chinese.

### .agents/notes/implemented/bug-fix/2026-09-20-session-open-read-coordination.i18n.yaml
- Hash sidecar for the session-open-read-coordination note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-27-pwsh-prompt-tail-grace.md
- Purpose: let a send whose prompt *marker* arrived but whose printable tail did not wait longer, instead of being charged the silence tier.
- Key abstractions: `dsh-terminal-bash` gains a validated `promptTailGraceMs`, default `0`; bound becomes `idleSilenceMs + handoffGraceMs + promptTailGraceMs`.
- Data flow: PTY chunks → OSC `133;D` marker seen → tail pending → grace applies → settle `stdin_read` (tail arrived) or `inferred_idle` (tail never came).
- Non-obvious design decisions: zero reproduces the previous bound bit-for-bit, so an upgrade changes no deployment's behaviour; `validateConfig` accepts zero — "the one numeric bound whose zero is a documented value" — and rejects negative/fractional values.
- Edge cases / failure handling: the grace applies *only* after a marker was seen, so a lost prompt still fails at the plain bound; the committed test keeps the default because a nonzero value would turn a never-arriving tail from a named failure into a slow pass.
- Surprising: the note names the exact measurement — a native Windows probe showed the prompt renders as two pty chunks (marker, then the 5-byte `dsh> ` 2–28 ms later) under both Windows PowerShell 5.1 and pwsh 7.6.6.

### .agents/notes/implemented/bug-fix/2026-09-27-pwsh-prompt-tail-grace.zh.md
- Chinese twin; its 问题 records the two-chunk render and the ~3 s cost per affected send.

### .agents/notes/implemented/bug-fix/2026-09-27-pwsh-prompt-tail-grace.i18n.yaml
- Hash sidecar for the prompt-tail-grace note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-28-pty-bundled-console-host.md
- Purpose: make the `serial / windows (self-hosted standby)` drill green by changing the console host, not the readiness rule.
- Key abstractions: `subprocess-local` allocates Windows terminals with node-pty's `useConptyDll: true` (bundled OpenConsole) — set only when `process.platform === 'win32'`.
- Data flow: Windows PTY spawn → bundled conpty → prompt renders `dsh> ` verbatim → the readiness rule's exact tail match succeeds.
- Non-obvious design decisions: the OS console host replays the prompt line as `\ndsh>\x1b[1C` once output scrolls the viewport, which matches neither `dsh> ` nor its prefix; the previous `promptTailGraceMs` fix could not help because a malformed tail is not a *late* tail.
- Edge cases / failure handling: POSIX allocation is unchanged; the desktop runtime file policy that retains `conpty.dll` / `OpenConsole.exe` becomes load-bearing for terminal allocation, not merely for distribution.
- Surprising: the note explicitly rejects "teach `TerminalSanitizer` to tolerate the OS quirk" — writing one console host's quirk into the sanitizer would just relocate the divergence.

### .agents/notes/implemented/bug-fix/2026-09-28-pty-bundled-console-host.zh.md
- Chinese twin; its 问题 gives the pool-machine measurement (5 of 7 prompts malformed) that no tail bound could cover.

### .agents/notes/implemented/bug-fix/2026-09-28-pty-bundled-console-host.i18n.yaml
- Hash sidecar for the bundled-console-host note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-29-reused-blank-runs-requested-preset.md
- Purpose: a reused blank Session must run the *requested* preset, not the preset recorded in the blank's log (issue #2566).
- Key abstractions: `session.create` treats a named `sessionId` as a reuse *candidate* the Host verifies (not started, right directory, unarchived member of the Workspace, not owned by another writer).
- Data flow: client names a blank → Host verifies under the acquired writer → runs the requested `agentPreset` (or the configured default) → a live Session switches via the preset registry's `select`, a persisted one records `agent-preset/selected` in its unpublished resume setup.
- Non-obvious design decisions: the Host does *not* resolve the recorded preset for reuse, so a removed preset definition can never break a New Session; requests naming one identity run in arrival order including preset resolution.
- Edge cases / failure handling: a candidate that started, fails placement, or is written by another owner stays unchanged and the Host creates a new Session; the response names the Session actually used; a blank whose first prompt was accepted but whose turn has not started still counts as blank.
- Surprising: the client retries only `session/writer-held`, so a stale blank stayed first in line and poisoned every later New Session; the fix moves writer contention entirely to the Host.

### .agents/notes/implemented/bug-fix/2026-09-29-reused-blank-runs-requested-preset.zh.md
- Chinese twin; its 问题 names issue #2566 and the stale-blank-first ordering.

### .agents/notes/implemented/bug-fix/2026-09-29-reused-blank-runs-requested-preset.i18n.yaml
- Hash sidecar for the reused-blank-preset note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-30-job-session-lifecycle.md
- Purpose: make a job's execution interval reconstructable by SDK consumers who never collect its output.
- Key abstractions: `job/registered` and `job/settled` facts appended to the owning Session log; a UUID-backed `JobId` that identifies both live controls and historical records.
- Data flow: job registry commit → synchronous journal append (before live hub reactions and completion waiters resume) → Session persistence → SDK notification.
- Non-obvious design decisions: `producerReported` distinguishes a producer report from forced bookkeeping (true when `JobHooks.done` fulfils, false when it rejects or teardown cancellation throws) — it reports fulfilment, not independently confirmed resource release.
- Edge cases / failure handling: a failed journal append warns independently and can never prevent cleanup or release of waiters; missing terminal records stay incomplete and are *not* reconstructed from later reads or a restart.
- Surprising: teardown can close the Session writer before the final settlement lands, so "normal one-shot completion and signal shutdown can therefore leave incomplete history" — the journal is best-effort, not transactional.

### .agents/notes/implemented/bug-fix/2026-09-30-job-session-lifecycle.zh.md
- Chinese twin; its 问题 notes that a background tool can return before the work finishes and that runtime-local ids repeat after a registry restart.

### .agents/notes/implemented/bug-fix/2026-09-30-job-session-lifecycle.i18n.yaml
- Hash sidecar for the job-lifecycle note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-09-30-session-list-host-fairness.md
- Purpose: stop a big cached projection state from monopolising the Host while a Session list is assembled.
- Key abstractions: one monotonic deadline for classification and summary generation; the optional `listWorkSliceMs` deployment setting, default 16 positive integral ms.
- Data flow: `ApiSessionList` → per-row work → yield only when elapsed work exhausts the slice → new deadline after the wait.
- Non-obvious design decisions: "Row count alone is not a useful scheduling budget" — the slice is *time*, so a list of 3 000 cheap rows yields 3 times, not 3 000 (measured table at line 27+).
- Edge cases / failure handling: cancellation is checked per row, after each yield, and before returning; no partial list is returned; small lists get no forced final yield and no no-op async helper.
- Surprising: the note includes a full measurement methodology (three fresh child processes per workload, median-of-medians, a separate fifth call to measure worst queue delay) and a persisted-fixture benchmark over `generationLogPath` / `compressZstdFrame`.

### .agents/notes/implemented/bug-fix/2026-09-30-session-list-host-fairness.zh.md
- Chinese twin; its 问题 states that per-row yielding adds thousands of event-loop round trips on cheap lists.

### .agents/notes/implemented/bug-fix/2026-09-30-session-list-host-fairness.i18n.yaml
- Hash sidecar for the session-list-fairness note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-10-10-background-shell-command-display.md
- Purpose: show an explicit background Shell launch in the ordinary Shell command area, without pretending to know the job's live state.
- Key abstractions: the terminal component reads the original call's `background` flag and the call's `running` value; `background=true && running=true` means "the launch call is still in progress".
- Data flow: background `bash`/`pwsh` Start → command card shows command + cwd + wrapping + disclosure state → launch acknowledgement → the same card becomes a static command-only display.
- Non-obvious design decisions: the card deliberately drops the run-state dot, exit code, empty-output placeholder and running animation — "it does not describe the background job's running state".
- Edge cases / failure handling: launch failures keep the existing raw-argument + error-result presentation; Inspect still exposes the full arguments and the acknowledgement.
- Surprising: the note refuses to match later job output back to the original Tool because that needs a jobId↔callId index, incremental read rules, missing-history handling and de-duplication — "None of these is a prerequisite for displaying the existing command".

### .agents/notes/implemented/bug-fix/2026-10-10-background-shell-command-display.zh.md
- Chinese twin; its 问题 explains why the launch acknowledgement cannot establish execution completion.

### .agents/notes/implemented/bug-fix/2026-10-10-background-shell-command-display.i18n.yaml
- Hash sidecar for the background-shell-display note's heading blocks.

### .agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.md
- Purpose: remove two process-specific values (implementation checkout path, Web GUI URL) from the system prompt.
- Key abstractions: `@deepseek-ai/dsh-harness-dev-context` owns both sections and injects `systemPrompt`, `sessionProjections`, `webApp`; `dsh-host-webserver` owns `WebServer.getOrigin()` / `bindUrlHost(host)`; `dsh-web-app` owns `webApp.getAdvertisedUrl()`.
- Data flow: `dsh web` (random `--port 0`, A/B checkouts, npm vs Desktop install) → the two values change → previously they rewrote message 0 → now they are runtime context only.
- Non-obvious design decisions: the failure that forced this is Claude-specific — "Claude binds historical thinking-block signatures to the conversation prefix, system prompt included, so the upstream answers 400 (`Invalid signature … bound to a different conversation`)" (line 9). The prompt keeps only value-free guidance.
- Edge cases / failure handling: a Session whose log already holds the earlier format keeps its logged paragraphs; `CONTEXT_ORDERS.HARNESS_SOURCE = 200` / `WEB_SURFACE = 210` place the two sections.
- Surprising: the checkout path is computed as "four directories above this package's source or built entry" — the same depth as the former web-app location — so source, npm and Desktop installs resolve the same root.

### .agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.zh.md
- Chinese twin; its 问题 table lists the operations that changed the Web URL / checkout path invisibly.

### .agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.i18n.yaml
- Hash sidecar for the runtime-context-values note's heading blocks.

### .agents/notes/implemented/feature/2026-06-15-ptc.md
- Purpose: let the model compose tools by writing a program instead of emitting one tool call per step.
- Key abstractions: `ToolRuntime` gains a validated `mode: 'native' | 'ptc'` config; `ctx.ptcRuntime` (Service Definition package `dsh-ptc-runtime`, provider `dsh-ptc-runtime-node`); the reserved `run_code` transport; the `tools:sdk` prompt section.
- Data flow: model → `run_code({code, description})` → the registry builds per-tool bindings → `ctx.ptcRuntime.run(ctx.ptcRuntime.resolve(request))` → settlement after quiescence → canonical value + logs → `tool/result.content`.
- Non-obvious design decisions: only dispatch and the tool body overlap — `tools/pre-execute` and `tools/post-execute` run in model order because middleware may keep ordering-sensitive state (line 45 of the parallel note, line 51 here); sub-call `additionalContexts` are deferred through the parent because injecting inside `run_code` would break parent call/result adjacency (line 55); `run_code` declares **no** `presentResult`, so the client completes the card from raw durable `tool/result.content` (line 59).
- Edge cases / failure handling: `toolOrder` naming native capabilities *rejects* every PTC assembly (correct, not a bug); a failed program is never replayed implicitly because earlier effects may already have committed; the sandbox escalation uses the shared strict-widening approval helper.
- Surprising: the SDK prompt text opens by naming `code` and `description` as the call's two required arguments, because a model that emits `{code}` alone loses the whole written program to an `INVALID_ARGS` rejection (line 91); and "The declaration prefix can be as large as native schemas, but remains stable for provider caching" (line 89).

### .agents/notes/implemented/feature/2026-06-15-ptc.zh.md
- Chinese twin; its 问题 cites Cloudflare's Code Mode observation and the token cost of re-entering every intermediate tool-result into context.

### .agents/notes/implemented/feature/2026-06-15-ptc.i18n.yaml
- Hash sidecar for the PTC note's heading blocks.

### .agents/notes/implemented/feature/2026-07-06-approval-seam.md
- Purpose: one closed permission decision shared by `tools/pre-execute`'s `ask` and the sandbox's post-denial escalation retry.
- Key abstractions: one package `dsh-user-approval` owns the vocabulary and the `ctx.approval` service (line 15); answerers are `approval/request` waterfall listeners registered by channel-owning plugins; a per-session policy tier can decide before a channel is involved.
- Data flow: consumer asks → policy tier → channel-owning answerer → closed outcome → each consumer derives its own tool result.
- Non-obvious design decisions: the *mechanism* lives in the package, the *policy* (who answers, whether a session is asked at all) lives outside it; one package rather than the usual capability-seam three.
- Edge cases / failure handling: "Not loading it is the fail-closed opt-out: consumers deny unanswerable requests with zero approval code registered" (line 19) — the opt-out is a denial, not a pass.
- Surprising: routing is an ownership problem — a permission request must reach the channel that owns the asking agent and "fail closed for agents nobody owns", while staying out of deployments that compose no answerer.

### .agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md
- Chinese twin; its 问题 names the two callers and the ownership-routing problem.

### .agents/notes/implemented/feature/2026-07-06-approval-seam.i18n.yaml
- Hash sidecar for the approval-seam note's heading blocks.

### .agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md
- Purpose: overlap independent sibling tool calls without giving the model a scheduling knob.
- Key abstractions: optional per-tool `isConcurrencySafe(args)` — synchronous, pure, unary; `ctx.tools.executionMode(exec)` returning a tagged `parallel | exclusive` mode; `maxParallelToolCalls` (default 10).
- Data flow: assistant message completes → every call parsed once → a distinct `ToolExecution` per call → consecutive parallel calls form a group, an exclusive call is a singleton group *and* an ordering barrier → groups run sequentially, each group on a rolling pool → a commit cursor appends `tool/result` and collects `additionalContexts` only when the next model-order slot is ready.
- Non-obvious design decisions: only an explicit `true` opts in — a missing classifier, invalid arguments, a thrown classifier, or any other return value makes the call exclusive (line 17). The classifier is deliberately *unary*: "the scheduler does not compare calls or prove that their resource accesses are compatible" (line 19). Classification is lazy and re-run after every barrier, so a registry mutation changes not-yet-started calls (line 29).
- Edge cases / failure handling: unknown tools fail closed to exclusive; an abort stops replenishment, drains started calls, commits in order and records synthetic aborted call/result pairs for undispatched ones; a scheduler failure waits for started dispatches and rethrows the first failure; `defineTool()` validates arguments *before* invoking a typed classifier, so invalid arguments classify as exclusive and only error if the call actually executes.
- Surprising: "only dispatch and the tool body overlap" — `tools/pre-execute` / `tools/post-execute` stay in model order, and `tools/execute` wrappers "must be reentrant across distinct executions" (line 45). Filesystem read opts in via a narrow recorder exception, relying on write/edit re-checking the observed version (→ `FS_STALE_VERSION`).

### .agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.zh.md
- Chinese twin; its 决策 states that only an explicit `true` opts in and that concurrency is a host concern, not model-facing metadata.

### .agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.i18n.yaml
- Hash sidecar for the parallel-tool-call note's heading blocks.

### .agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md
- Purpose: give a delegation tool control over the child's persona, tool visibility and recursion depth without one provider per combination.
- Key abstractions: `persona` = a child-scoped section named `deployment:persona-prefix`; `toolFilter` = `ToolRuntime.restrict()` in the child's scope; `maxDepth` = an absolute non-negative safe-integer cap; `SubagentCapabilities.depthLimit`.
- Data flow: manager → setup callback composes the preset, restores historical persona/restrictions on cold resume, installs structured output → only then publishes the child and lets the driver start.
- Non-obvious design decisions: the filter is *one live global-view rule* — "the registry's single resolver applies the same result to wire tool schemas, lookup, execution, and PTC mode SDK generation" (line 39); allow is applied before deny and multiple restrictions intersect; child-scoped tools are added *after* global filtering and may shadow an admitted global tool; the registry stays live, so a deny-only filter admits a later global name unless it explicitly denies it (line 50).
- Edge cases / failure handling: configuration fails loudly when a filter supplies neither allow nor deny or names an out-of-set name; `allow: []` is valid and hides every global tool; a setup failure rolls back the private child so no observer can see a child whose first prompt used the wrong persona.
- Surprising: an explicit section — "**Visibility is not authority**" (line 76): the filter does not create a parent-to-child grant lattice, does not require the child to be a subset of the parent, and cannot stop code with another Cordis context from calling services directly. Depth is the *only* hard bound, and it is enforced at every start, including for direct `SubagentStartRequest` callers.

### .agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.zh.md
- Chinese twin; its 决策 states plainly that the controls "compose trusted same-process behavior; they do not authorize it".

### .agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.i18n.yaml
- Hash sidecar for the subagent-persona note's heading blocks.

### .agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md
- Purpose: continue an interactive terminal conversation across tool calls.
- Key abstractions: `dsh-terminal` (`ctx.terminals`, branded `TerminalSessionId`, backend registry) + `dsh-terminal-bash` (a backend over `ctx.subprocess.spawnTerminal()`).
- Data flow: agent tool → terminal session → readiness detection → bounded terminal buffers → owner-scoped lifecycle.
- Non-obvious design decisions: this is an *additional* capability, not a replacement — "The existing `bash`, `read`, `write`, and `edit` tools remain the reliable default for bounded, auditable operations"; the PTY family does not change `agent-loop`.
- Edge cases / failure handling: full-screen apps, keystroke sequences, BEL control flow, restoration after process loss and cross-agent sharing are explicitly deferred.
- Surprising: the motivating workflows are `gdb`, REPLs and line-oriented editors like `ed` — state that lives in a terminal rather than a file.

### .agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md
- Chinese twin; its 问题 lists the gdb/REPL/`ed` workflows excluded by per-call shells.

### .agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.i18n.yaml
- Hash sidecar for the persistent-PTY note's heading blocks.

### .agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.md
- Purpose: give the model a small control API for goals without exposing the lifecycle verbs to plugins.
- Key abstractions: `@deepseek-ai/dsh-tool-goal` contributes `get_goal`, `create_goal`, `update_goal` over `ctx.goals`, plus one system-prompt policy section; compare-and-set `goal_id` + `revision`.
- Data flow: model tool call → execution-time authority checks → durable goal mutation → a wrap-up instruction deferred onto the tool result so the model still addresses the user before the turn ends.
- Non-obvious design decisions: authority is *execution-time*, not prompt-level — "Every call requires an `exec.agent` that is the exact running object in `AgentRegistry`, is the current inherited driver initiator, and has an open turn" (line 29); and "User source is a host attestation: every `Agent.followup()` or `steer()` input requires an explicit source" (line 31).
- Edge cases / failure handling: create/edit/pause/resume additionally need an accepted human message or user steering event in the current turn *of a runtime-root agent*; a durable paused goal rejects `resume` with `GOAL_TOOL_RESUME_PAUSED` (the user-facing path owns that transition); empty-string optional fields and a zero `max_goal_rounds` are treated as strict-schema fillers and count as omitted.
- Surprising: `blockedAfterConsecutiveRounds` (default 3) is a *mechanical* floor — the runtime cannot tell whether the rounds hit the same condition, so semantic equivalence stays a model judgment (line 37). Autonomous rounds may complete or block but may not edit, pause, resume or replace the human objective.

### .agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.zh.md
- Chinese twin; its 决策 rejects "rely on prompt instructions for authority" outright.

### .agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.i18n.yaml
- Hash sidecar for the goal-tools note's heading blocks.

### .agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.md
- Purpose: stop PTC mode from flattening every tool result back into one string.
- Key abstractions: canonical `JsonValue` per tool (`ToolOutputMap`), `ToolCallError` (declared on the runtime request as `{ name: "ToolCallError", memberNameProperty: "toolName" }`), the outer output ledger (`maxOutputBytes`, default 67 108 864), typed handles (`{ kind: 'background', jobId }`, `{ id, pluginName, state, provides, waitingFor }`).
- Data flow: registry projects args+output schemas → generated SDK (`jsonSchemaToTs()`) → worker executes bindings → each successful binding resolves to the final canonical `JsonValue` → the outer `run_code` result is `{ logs: string[], result?: JsonValue }` → the outer ledger charges logs + completion against one budget.
- Non-obvious design decisions: bindings cross the worker boundary as a *flat pre-order token stream* whose transport nesting is bounded, so there is "neither a JavaScript call-stack depth cap nor a platform-specific nested structured-clone limit" (line 56); the worker captures its own realm's `Array.prototype`/`Object.prototype` identities and every structural intrinsic at module init, so model code replacing `Object.keys` or `Array.isArray` cannot change validation, wire transport or byte accounting.
- Edge cases / failure handling: `undefined`/non-finite/`-0`/sparse arrays/cycles/functions/exotic objects reject the call *before* the tool runs; a completion that cannot survive lossless JSON snapshotting fails as `invalid-output`; an over-cap value fails as `output-limit` rather than being inspected or truncated (line 62); native stdout/stderr writes that bypass the patched stream slots use independent pipes so settlement stays bounded.
- Surprising: intermediate values have **no byte cap at all** — "Intermediate values are not prompt-truncated, context-spilled, or persisted" — because they never enter model context, and the outer ledger never charges them. A failing program is never replayed implicitly.

### .agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.zh.md
- Chinese twin; its 决策 explains the flat pre-order wire encoding that removes structured-clone depth limits.

### .agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.i18n.yaml
- Hash sidecar for the typed-tool-returns note's heading blocks.

### .agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md
- Purpose: let a parent send *later* work to the same live child, without a second queue.
- Key abstractions: one durable Session + at most one process-local **Activation** (a residency epoch owning one retained `AgentHandle`); the Agent inbox as the only turn FIFO; `ctx.subagents.startActivation()` returning a receipt with `childId`, `messageId`, `result`, `dispose()`.
- Data flow: `prepareContinuable()` → manager reserves the id, calls `ctx.agents.create()` through a private activation-owner scope, installs the handle, then `Agent.followup(initialPrompt)` → inbox acceptance yields a `MessageId` → the Activation may run many FIFO turns and stays resident while descendants live.
- Non-obvious design decisions: "The Agent inbox is the only queue. Agent messages use Steer; human prompts choose Queue or Steer." (line 90); the manager derives `running | waiting | settled` from Agent quiescence, inbox pending state and the owned-child set instead of keeping a second state machine (line 82); the activation-owner scope exists because Cordis unwinds owner effects in reverse registration order and cannot express a dynamic child graph.
- Edge cases / failure handling: any failure before inbox acceptance rejects *without* returning either id and rolls back the handle, the Activation and the parent's `ownedChildren` membership; the final settlement awaits `ctx.sessions.flush(child.session)` but deliberately ignores the flush boolean because "listener participation cannot identify a persistence backend"; a rejected flush is logged and the revalidation still proceeds so a failure cannot leak a `waiting` Activation.
- Surprising: "Only messages written to the child Session log are reconstructable with the source that supplied them; inbox acceptance alone provides no restart guarantee" (line 140) — an accepted-but-unlogged follow-up is lost on a crash and is *not* replayed. Also: `SubagentProvider.resume?()` and `SubagentProviderResumeRequest` are deliberately **absent** — cold resume goes through `ctx.agents.resume()` and never needs the original provider.

### .agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md
- Chinese twin; its 决策 explains why a Task-backed manager creates two FIFOs with no single ordering authority.

### .agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.i18n.yaml
- Hash sidecar for the continuable-subagents note's heading blocks.

### .agents/notes/implemented/feature/2026-08-05-agent-teams.md
- Purpose: peer communication, a stable named roster and shared task ownership on top of the continuable-child seam.
- Key abstractions: every runtime root is the implicit Lead of a Team identified by its `SessionId`; a flat roster of immutable lowercase-kebab-case names; shared tasks as complete snapshots with monotonic revisions and `expectedRevision`; `wait_agent`.
- Data flow: `spawn_teammate` → provisioning snapshot `team/member` flushed in the Lead Session → the reserved continuable child starts → inbox acceptance → `active`; failures append a `failed` snapshot and the name is burned forever.
- Non-obvious design decisions: tasks are compare-and-set — "Every mutation carries `expectedRevision`" and only the Lead may assign another member (line 47); `wait_agent` "blocks on one roster, mailbox, task, or live-status edge registered after the call starts instead of encouraging model polling" (line 49); `writeScopes` are advisory path prefixes that "produce overlap diagnostics but never block claim or authorize a write".
- Edge cases / failure handling: a failed provisioning permanently consumes its name and member slot; a root recovery reconciles an unterminated provisioning record against the child's independently persisted Session and reports a provisioning conflict rather than keeping an orphan; the Team domain never infers branches, creates worktrees or merges.
- Surprising: "Treat task ownership or write scopes as locks" is explicitly **rejected** — "False mutual exclusion is more dangerous than an explicit warning" (line 71). And every Team tool declares its complete result schema and renders it as compact JSON "so the compiler checks each `execute` against what the model is promised and no result spends tokens on indentation" (line 79).

### .agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md
- Chinese twin; its 决策 rejects treating ownership or write scopes as locks.

### .agents/notes/implemented/feature/2026-08-05-agent-teams.i18n.yaml
- Hash sidecar for the agent-teams note's heading blocks.

### .agents/notes/implemented/feature/2026-08-05-context-form-vocabulary.md
- Purpose: stop every injected context row from rendering as one wall of escaped inline JSON.
- Key abstractions: `MessageSource` gains `form: ContextForm` — a small tagged vocabulary (instructions / catalog / snapshot / notice / relay / recall) **independent of** `kind`.
- Data flow: producer → durable `MessageSource` with facts + shape → client renders a typed card; unknown kinds, a form absent from the source, or an unusable `catalog` fall back to the **opaque** body (model-facing text with real line breaks + remaining source fields).
- Non-obvious design decisions: the vocabulary is semantic, never visual — colours, icons, ordering and collapse defaults are the consumer's business and "must not enter the union" (line 22); catalog entries are stored **unescaped** so the pseudo-XML escaping belongs to the `<available_skills>` frame only, and the republish digest covers the durable entries rather than the rendered text (line 28); readers are all-or-nothing — "one unreadable entry disqualifies the record rather than being dropped, because a body that replaces the model-facing text must not present a confident but incomplete account of what the model read" (line 40).
- Edge cases / failure handling: the producer side validates the same durable data with the same posture — an unreadable catalog is skipped as "not this plugin's record" rather than thrown, because throwing there "would fail every later step of that session at the latest, least diagnosable point"; one v0→v1 case does not self-heal (an old-form catalog with no current skills leaves a stale catalog).
- Surprising: there is deliberately **no** presenter registry, because a tool's `args` are model-generated (a translation step is unavoidable) while a context `source` is built by the producing plugin under no external constraint — "a registry would have bought a translation nobody needs" (line 48).

### .agents/notes/implemented/feature/2026-08-05-context-form-vocabulary.zh.md
- Chinese twin; its 决策 explains why the producer, not the client, owns the shape.

### .agents/notes/implemented/feature/2026-08-05-context-form-vocabulary.i18n.yaml
- Hash sidecar for the context-form-vocabulary note's heading blocks.

### .agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md
- Purpose: give the win32 sandbox rung a real confining executor (the historical decision left `PLATFORM_CHAINS.win32` empty, so Windows profiles degraded to danger-full-access).
- Key abstractions: `CreateRestrictedToken` with `WRITE_RESTRICTED | DISABLE_MAX_PRIVILEGE | LUA_TOKEN`; restricting SIDs derived deterministically from the canonical workspace path (`workspaceWriteSid`, sha256 → `S-1-4-x-y`) and from a per-session random temp path (`tempWriteSid`).
- Data flow: sandbox resolution → restricted token + ACEs on granted roots → child process runs with reads still ambient and writes requiring a capability ACE.
- Non-obvious design decisions: the mechanism restricts by *token derivation*, not identity — reads pass the normal check alone, so "this rung needs no read grants and no new account" (line 33 region); Logon SID + Everyone are keep-alive invariants because early DLL init dies with `0xC0000142` and CNG crashes pwsh with `0xE0434352` without them; the per-workspace SID's standing ACE doubles as the cross-session reuse cache with an exact-ACE skip.
- Edge cases / failure handling: the port "checks every API call and fails closed (the POC fail-opened on ignored failures)"; a workspace equal to or containing the temp root fails before any ACL mutation; the provider reports `enforcement: 'partial'` because a hard link into a granted workspace still grants an external alias and a Low-integrity token cannot open an AppContainer-stamped tree.
- Surprising: the diagnosis skill must run its *preserving* ACL repairs **outside** the confined token (that token cannot inspect the conflicting objects), and every repair is backed up and verified; "Because tool output keeps only its tail, every record is also written to a report file under the output directory and the run ends with a recap line".

### .agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.zh.md
- Chinese twin; its 决策 explains why the identity routes (restricted-user, AppContainer) were rejected.

### .agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.i18n.yaml
- Hash sidecar for the Windows-ACL-sandbox note's heading blocks.

### .agents/notes/implemented/feature/2026-08-15-product-subagent-noninteractive-permissions.md
- Purpose: run Claude-Code / Codex product subagents unattended without letting anyone raise their own authority.
- Key abstractions: a per-Provider, Profile-level `permissionMode` using the products' *native* names (`dontAsk`, `acceptEdits`, `auto`, `plan`) rather than a shared restricted/automatic/full abstraction.
- Data flow: profile config → the Provider fixes the resolved value for every run from that plugin instance → the product SDK gets that mode → a permission refusal surfaces as a distinct stop reason rather than a generic failure.
- Non-obvious design decisions: "The subagent tool schema and `SubagentStartRequest` contain no permission field, so a model or individual delegation cannot change it" (line 13).
- Edge cases / failure handling: a failed product run must let the foreground parent and a background Job distinguish a permission refusal from another failure — "Reusing assistant output for that fact would misattribute infrastructure detail to the child model".
- Surprising: the decision separates *what the product natively supports* from *what this harness would like to express*, refusing to invent an abstraction that would have to be mapped back.

### .agents/notes/implemented/feature/2026-08-15-product-subagent-noninteractive-permissions.zh.md
- Chinese twin; its 问题 separates permission refusal from other product-run failures.

### .agents/notes/implemented/feature/2026-08-15-product-subagent-noninteractive-permissions.i18n.yaml
- Hash sidecar for the product-subagent-permissions note's heading blocks.

### .agents/notes/implemented/feature/2026-08-24-user-authorized-subagent-model-routes.md
- Purpose: stop "the adapter registry is reachable" from silently becoming "the parent may choose any model".
- Key abstractions: a Host `subagent-model-selection` settings section with `enabled` + `allowedModels` (exact `{provider, model}` routes); a per-Session `subagent/model-selection-policy` snapshot.
- Data flow: user stages the switch and routes in one revision-fenced settings mutation → a newly composed top-level Session snapshots the list → child Sessions inherit that exact list; resumed Sessions use the *recorded* event, not current settings.
- Non-obvious design decisions: the list is never rendered into the delegation description, because "a large or changing list would enlarge every request and invalidate an early prompt prefix" (line 23); the delegation executor independently rejects any explicit provider/model/effort outside the Session list *before* `resolveCallConfig()` validates adapter availability; a call that supplies no selection field keeps configured or inherited routing.
- Edge cases / failure handling: a stored route absent from the live directory stays visible as unavailable and removable; a provider-local catalog failure does not block other providers or erase saved authorization; a connection reset discards the draft because namespace revisions are comparable only within one Host process.
- Surprising: "Model selection has no unrestricted static mode. The default-off Host setting is the only authority" (line 19) — and the shipped fork tool exposes no route selection at all, deliberately, "so inherited conversation prefixes remain eligible for provider-side KV Cache reuse".

### .agents/notes/implemented/feature/2026-08-24-user-authorized-subagent-model-routes.zh.md
- Chinese twin; its 决策 explains why the allowlist is not rendered into the delegation description.

### .agents/notes/implemented/feature/2026-08-24-user-authorized-subagent-model-routes.i18n.yaml
- Hash sidecar for the subagent-model-routes note's heading blocks.

### .agents/notes/implemented/feature/2026-08-26-generic-file-upload.md
- Purpose: let a user hand the agent a PDF, data file or archive, not just an image.
- Key abstractions: two storage schemes + one ordered attachment list; content-addressed objects at `DSH_HOME/attachments/v1/file-objects/<digest-prefix>/<digest>` with per-name hard links under `…/files/<digest-prefix>/<digest>/<name>`; a FIFO upload queue defaulting to two active transfers; a `FileBlock { name, bytes, attachmentId }` inside `user/message`.
- Data flow: composer → upload Worker (XMLHttpRequest for byte progress, or Fetch for streams) → Host streaming route → bounded chunks to a private staging object → atomic publish → the receipt resolves to a durable reference → the model-facing request carries a *handle* naming the read-only path.
- Non-obvious design decisions: "No provider receives file bytes; the model reads the stored copy with existing file tools on demand" (line 13) — and the handle explicitly tells a main agent to include the path when delegating and to report when a child's environment cannot see it.
- Edge cases / failure handling: the Host rejects upload completion after the original Agent is disposed and de-duplicates prompt retries by `rpcId`; the page thread never reads, base64-encodes or JSON-serialises generic file bytes; the Host rejects any file block received for a child session; a cancellation or failure removes the staging file.
- Surprising: there is no type whitelist and no size cap — "DeepSeek Chat's whitelist exists because its server parses uploads, while this harness only stores bytes and lets the model read them" (line 13 region). Upload state belongs to the resident conversation root, so navigating away does not stop the transfer.

### .agents/notes/implemented/feature/2026-08-26-generic-file-upload.zh.md
- Chinese twin; its 决策 rejects storing uploads in the project root and eager prompt injection.

### .agents/notes/implemented/feature/2026-08-26-generic-file-upload.i18n.yaml
- Hash sidecar for the generic-file-upload note's heading blocks.

### .agents/notes/implemented/feature/2026-08-28-auto-review.md
- Purpose: let a model act as the approver in Full-access mode, with an explicit authority policy.
- Key abstractions: `dsh-experimental-auto-review` as an explicitly installed experimental Web layer; durable identity `permission/preset:auto`; a fixed risk taxonomy (low / medium / high).
- Data flow: every native call and every started PTC `tools.*` inner call receives one review before its body; the outer `run_code` transport and direct Node effects stay outside the guarantee.
- Non-obvious design decisions: classification is by the action's **actual effects**, "not its name or claimed intention" (line 19); medium risk needs "explicit current human or direct-parent authorization naming action, exact target, and necessary scope"; high risk is denied "including an explicitly requested action".
- Edge cases / failure handling: there are no tool-name exemptions, cached grants, retries, configurable policy or a second authorization check — and "A repeated call receives a fresh review".
- Surprising: selecting Auto uses Full access's `danger-full-access` sandbox but a *separate* durable permission identity, precisely so a child inheriting an older fork prefix cannot silently inherit the approval policy.

### .agents/notes/implemented/feature/2026-08-28-auto-review.zh.md
- Chinese twin; its 决策 gives the low/medium/high risk table.

### .agents/notes/implemented/feature/2026-08-28-auto-review.i18n.yaml
- Hash sidecar for the auto-review note's heading blocks.

### .agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.md
- Purpose: give the JSONL backend durable cross-process write ownership.
- Key abstractions: `SessionWriteLease` (`packages/session/session-persistence-jsonl/src/lease.ts`) holding a kernel lock on `session.lock` for the whole life of a write handle — POSIX `flock(2)` via a prebuilt native binding, Windows a **named kernel semaphore** (count 1) derived from the canonical lock path.
- Data flow: write-open of an existing artifact → acquire the lease → (for a created session) acquire just before the first materializing write → release on close.
- Non-obvious design decisions: the kernel releases the lock when the holder dies, "so a crashed holder never blocks a successor and no expiry bookkeeping exists"; contention maps to `SessionAlreadyOwnedError`; "Because a POSIX lock names an inode rather than a path, acquisition verifies the locked inode is still the file at the lock path and retries otherwise" (line 13).
- Edge cases / failure handling: a live-but-wedged holder keeps the lock until its process exits (expropriation rejected — its resumed appends would tear the log); release never removes the lock file, preserving the stable inode later lockers verify against; the browser-worker deployment stubs the flock entry to immediate success but keeps the inode-replacement check.
- Surprising: the first implementation was a TTL record + claim-by-rename and was **replaced in review** as "a distributed algorithm in miniature"; Windows byte-range locks were rejected after CI proof (they are mandatory, so `ripgrep` died with error 33 walking a session directory) and `CreateFileW` share-mode denial was rejected because it broke recursive temp-root cleanup with EBUSY.

### .agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.zh.md
- Chinese twin; its 决策 records that the TTL+rename design was replaced in review.

### .agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.i18n.yaml
- Hash sidecar for the session-write-lease note's heading blocks.

### .agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md
- Purpose: keep the provider prefix cache warm when the system prompt changes.
- Key abstractions: `SystemPromptUpdate = 'in-history'` on `LlmResolvedModelInfo` / `PreparedLlmCall`; `SystemPromptProjection.project(rendered, { inHistory, startsSeries })` in `packages/core/agent-loop/src/runtime-context.ts`; `RequestContext.systemPromptUpdate` as a `request/context` field.
- Data flow: rendered prompt → projection over surviving `system/message` nodes → on a capable route and a continuing series, **append** a new `system/message` before the step's `user/message` events (message 0 untouched); on an incapable route or a new series, log empty replacements for later nodes and rewrite the head.
- Non-obvious design decisions: the model fact is stated up front — "A DeepSeek model … accepts a `system` message at any position of the conversation and treats the latest one as the complete effective system prompt, replacing the leading one" (line 11); `startsSeries` is true on `startsRequestSeries`, on a surface replace generation move, or on a tool-schema change on a route without `toolUpdate`; a provider/model swap alone is *not* a series start, because the route change already misses the cache.
- Edge cases / failure handling: an empty rendering clears *every* active system node (otherwise an older prompt would become effective again); dormant empty tails supply no effective text, so repeated clearing and resume cannot resurrect an old prompt; projection happens *after* the `agent/pre-step` waterfall so a compaction performed inside it cannot leave a just-appended node shadowed; cancellation during either async request phase commits neither the prompt nor accepted users.
- Surprising: `dsh-token-meter` prices the last non-empty surviving system node as `contextBreakdown.systemTokens` and every other visible node as `messageTokens`; and Trajectory picks "the newer of the preceding real header and the preceding synthetic system header" because comparing only real headers would report the wrong previous prompt for an A→B→C sequence (line 48).

### .agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.zh.md
- Chinese twin; its 决策 tabulates the four route/prefix-state operations and the `startsSeries` rule.

### .agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.i18n.yaml
- Hash sidecar for the in-history-system-prompt note's heading blocks.

### .agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.md
- Purpose: replace the single-purpose Detail panel with a general per-session docking surface.
- Key abstractions: `ui-sidebar-right` over the `ui-dockkit` engine — split panes, tabs, floating panels, an undoable operation sequence — owning the frame's right column and per-session state.
- Data flow: plugin tab types register into the surface; the sidebar's Document Preview / file tree / guide are just shipped types; the panel opens content from the conversation.
- Non-obvious design decisions: the note owns the *surface* and explicitly delegates content ("What lives in the surface is decided elsewhere"), keeping tab-type declaration, the client resource model and the workspace file service in their own packages.
- Edge cases / failure handling: produced-file chips and `read` path links previously handed the path to the OS via `session/openWorkspacePath`, so a remote browser could not look at the file at all; the new surface makes the file readable in-product.
- Surprising: the old details panel "duplicated the chat rows' cards at full height, a second presentation surface every card had to keep in step".

### .agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.zh.md
- Chinese twin; its 问题 names the Detail panel's duplication and the plugin-hostile single slot.

### .agents/notes/implemented/feature/2026-09-04-right-sidebar-docking-infrastructure.i18n.yaml
- Hash sidecar for the right-sidebar-docking note's heading blocks.

### .agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.md
- Purpose: serve DeepSeek over the Anthropic Messages protocol without losing thinking/signatures.
- Key abstractions: one `deepseek-official` route under the `llm-deepseek` settings namespace; `PreparedAdapterCall` freezing endpoint/credential/model capabilities; a versioned `ReplayEnvelope` storing only protocol format, model identity, aligned block kinds and signatures.
- Data flow: request → Messages wire → assistant blocks remain the durable model-visible content → the next turn restores signatures verbatim from the envelope (including empty signatures).
- Non-obvious design decisions: "DeepSeek effort uses `output_config.effort`; an Anthropic thinking token budget does not control DeepSeek effort", and the adapter forwards an explicit `temperature` because DeepSeek accepts it with thinking enabled and ignores its value (line 15); a JSON syntax failure after a successful HTTP response is `INVALID_RESPONSE`, **not** `TRANSPORT`, and earns no retry.
- Edge cases / failure handling: unusable metadata follows the replay degradation rule — omit signatures with a warning while preserving durable content; historical tool arguments use the empty-input fallback; Messages keeps the initial top-level system and emits later snapshots as native system turns, preserving previously sent prefixes.
- Surprising: capability inference from protocol or model *names* is rejected — "support and update semantics depend on the deployed endpoint", so an endpoint override must support Messages.

### .agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.zh.md
- Chinese twin; its 决策 notes `output_config.effort` and the "declared, not inferred" capability rule.

### .agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.i18n.yaml
- Hash sidecar for the deepseek-messages-adapter note's heading blocks.

### .agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.md
- Purpose: let a user open and edit the files an agent produced, including shell-created files with no editor mutation record.
- Key abstractions: the `present` tool records a path and optional description under the Session filesystem access policy; the deliverables plugin opens it in the Host's default application.
- Data flow: model calls `present` → a `deliverables/presented` event is appended (only after a successful `tools/result`, for native *and* nested calls) → an authenticated POST selects a declaration by (viewed Session, event sequence, original file index) → the Host verifies regular-file existence and Host-path mapping → native open.
- Non-obvious design decisions: no content copy is made — "It records paths and optional descriptions without reading or copying contents" — with content preservation and copy-on-write deferred to a future persistence design; the event carries no owning Session ID, so relative paths in inherited history resolve against the *viewed* Session's workspace.
- Edge cases / failure handling: a later enclosing program failure does not revoke a completed nested declaration; blocked results publish none; same-name scoped replacements cannot publish another instance's results; a browser-supplied replacement path is never accepted.
- Surprising: Desktop metadata is invalidated with the connection generation so an old Host cannot keep native actions disabled or supply the wrong file-manager labels.

### .agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.zh.md
- Chinese twin; its 问题 states that preserving an independent delivered version adds storage, copy verification and a second editing destination.

### .agents/notes/implemented/feature/2026-09-08-present-workspace-source-files.i18n.yaml
- Hash sidecar for the present-workspace-source-files note's heading blocks.

### .agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.md
- Purpose: give a human an interactive shell beside a Session, distinct from the Agent's persistent terminals.
- Key abstractions: `api-terminal-controller` owns user terminals by Session and exposes the `terminal` Remote namespace; `ui-sidebar-terminal` registers xterm.js right-sidebar tabs; a keyed `sidebar.right.tab.guide.entry` slot dispatches by provider id.
- Data flow: guide entry → Host shell discovery → terminal creation with a discovered path → xterm rendering; the browser remembers the last shell path in origin-scoped localStorage.
- Non-obvious design decisions: "discovery alone allocates no process" — a shell is only spawned when a tab is actually opened; the terminal type declares independent instances so ordinary page deduplication cannot collapse separate processes; the Host remains authoritative for process state, titles and screen contents.
- Edge cases / failure handling: close/replacement remove the tab synchronously and run cleanup in the background, recorded under a terminal-specific localStorage key and retried at startup; cleanup failures have no notification and no manual retry; a definitive missing-Session response retires its saved close request while transport failures stay retryable; collapse, docking and browser disconnection all *preserve* the process.
- Surprising: theme colours are read from resolved CSS tokens and applied to xterm only when they change, and the DOM cursor reads the rendered cell background after each render — "so cursor movement never resets the palette".

### .agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.zh.md
- Chinese twin; its 决策 explains why the browser renderer must not be the Agent's readiness oracle.

### .agents/notes/implemented/feature/2026-09-09-web-sidebar-terminal.i18n.yaml
- Hash sidecar for the web-sidebar-terminal note's heading blocks.

### .agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.md
- Purpose: give a Session an isolated checkout without coordinating raw Git commands.
- Key abstractions: an experimental worktree runtime + `create_worktree({ name?, from? })`; the pool is `.agents/worktrees` under the current checkout's top-level directory.
- Data flow: tool → mounted subprocess + sandbox providers (no policy widening) → branch + checkout created from a pinned local commit → the shared working-directory service enters the canonical directory.
- Non-obvious design decisions: creation does not fetch or copy uncommitted files; the process creating a pool writes its own self-ignoring `.gitignore` while existing directories and ignore files are preserved; successful creation changes *only* the cwd — the Session identity and original sandbox root stay with their existing services.
- Edge cases / failure handling: both destination and shared Git metadata writes must already be permitted; failed setup can retain partial artifacts and reports their location; the service owns no checkout registry, cleanup schedule, merge policy or task association database.
- Surprising: the Team note explicitly points here rather than auto-creating worktrees, because worktree creation, branch naming, merge policy and cleanup are deployment choices.

### .agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.zh.md
- Chinese twin; its 问题 explains that changing a shell cwd does not update the Session's later tools.

### .agents/notes/implemented/feature/2026-09-13-explicit-worktree-creation.i18n.yaml
- Hash sidecar for the explicit-worktree-creation note's heading blocks.

### .agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.md
- Purpose: give Desktop agents predictable Python and an independent Node interpreter on machines without dev environments.
- Key abstractions: a release-bound payload (Python, Node, pnpm, data-processing and Office libraries) installed from application resources into the fixed Harness home; `runtime.json` carrying the application version, interpreter/package-manager versions, the Python distribution map and a **locked-input digest**.
- Data flow: the path-query tool installs the payload → returns absolute paths and bundled Python distribution versions → the digest identifies the payload regardless of directory name.
- Non-obvious design decisions: the digest covers the selected target's interpreter and wheel archives, shared wheel inputs, Python distribution versions, pnpm version and assembly format — other targets do not invalidate it; key order *within* the selected target participates in the identity while top-level lock key order does not; "Extraction or assembly changes that alter payload bytes without changing locked inputs require an explicit format bump".
- Edge cases / failure handling: installation publishes a completed staged copy and retains the previous directory until replacement succeeds; the shared Node build entry downloads and hash-verifies the complete locked wheel set rather than implementing dependency resolution; other `.data` installation schemes are rejected; native smoke runs after temp files are removed so interpreter links must survive relocation.
- Surprising: on macOS the x64 Node needs `com.apple.security.cs.allow-unsigned-executable-memory` *in addition* to JIT-only signing or it fails at startup under Rosetta in V8 `OS::SetPermissions`; and Windows public-key verification runs in batches of 32 files with at most four processes, keeping hardware operations serial.

### .agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.zh.md
- Chinese twin; its 决策 describes the macOS JIT entitlements and the Windows signed-packaging stages.

### .agents/notes/implemented/feature/2026-09-14-desktop-primary-runtime.i18n.yaml
- Hash sidecar for the desktop-primary-runtime note's heading blocks.

### .agents/notes/implemented/feature/2026-09-14-unattended-browser-terminal-reclamation.md
- Purpose: reclaim shells abandoned by a closed browser without killing work.
- Key abstractions: a two-hour idle grace; "no window holds it" AND "the Host continuously confirms idle activity" are both required.
- Data flow: last window disappears → Host confirms idle → grace starts → recheck before cleanup → reclaim.
- Non-obvious design decisions: "Running work and unknown activity cancel the idle deadline. When work finishes, a fresh full grace period starts; command runtime and output silence never impose a deadline" (line 13).
- Edge cases / failure handling: one of several holding windows disappearing retains the terminal; a window returning before cleanup reattaches the *same* process and cancels reclamation; if the saved process is gone the tab is preserved with a localized unavailability message and only an explicit click replaces it.
- Surprising: output subscriptions cannot detect abandonment — hidden tabs and inactive Sessions legitimately stop following the screen — so reclamation is driven by window ownership plus Host-confirmed idleness, not by stream activity.

### .agents/notes/implemented/feature/2026-09-14-unattended-browser-terminal-reclamation.zh.md
- Chinese twin; its 决策 tabulates retain/reclaim behaviour per window-holding and work state.

### .agents/notes/implemented/feature/2026-09-14-unattended-browser-terminal-reclamation.i18n.yaml
- Hash sidecar for the terminal-reclamation note's heading blocks.

### .agents/notes/implemented/feature/2026-09-16-browser-excel-preview.md
- Purpose: preview spreadsheets in the browser without a Host Office engine, and without losing formula/result relationships.
- Key abstractions: FortuneSheet with package-local adapters for ExcelJS, SheetJS CE and PapaParse; a package-local `XlsxPreviewArchive` that strips DrawingML parts from a temporary ZIP.
- Data flow: `remote.workspaceFiles.readBytes(sessionId, path, {}, signal)` → native bytes through the binary Remote → adapter (bytes, format, limits) → worksheet data → shared display formatting.
- Non-obvious design decisions: the adapter has no React state setters, timers or component references — dependencies own parsing, adapters share only formatting and initial selection; CSV/TSV keep literal strings because "implicit type inference could otherwise discard leading zeros or interpret source text as formulas"; preview is read-only and keeps saved formula results so "unsupported functions cannot replace a valid saved result with an error".
- Edge cases / failure handling: ExcelJS ignores worksheet drawing references, so ignoring those alone still leaves its archive-level drawing parser exposed — hence the ZIP-level part removal; the source bytes and retained worksheet XML stay unchanged; unsupported content is reported in a separate notice.
- Surprising: the limit ladder is explicit and ordered — a source-byte limit *before* parsing, a combined rectangular-area limit *before* FortuneSheet matrix allocation, and a timeout for stalled parsing (line 21) — and the note says plainly: "These limits do not claim a hard memory sandbox."

### .agents/notes/implemented/feature/2026-09-16-browser-excel-preview.zh.md
- Chinese twin; its 决策 names the byte limit → area limit → timeout ordering.

### .agents/notes/implemented/feature/2026-09-16-browser-excel-preview.i18n.yaml
- Hash sidecar for the browser-excel-preview note's heading blocks.

### .agents/notes/implemented/feature/2026-09-16-sidebar-browser.md
- Purpose: give the Sidebar an independent surface for visiting a Web page, with its own trust model.
- Key abstractions: the multi-instance `browser` right-sidebar tab type; `SidebarRightTabParamsMap.browser` accepting an optional initial URL so another plugin can open a browser without importing this package's runtime values.
- Data flow: a Markdown anchor → `MarkdownDelegateProvider` owner callback → a new `browser` tab with the URL as typed navigation parameters (or the system browser when the type is not registered); the address parser accepts `http:`/`https:` (loopback included, a bare host becomes HTTPS) and rejects embedded credentials, the app's own origin, malformed addresses, `file:` and every other scheme.
- Non-obvious design decisions: the default Web policy is `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` with no direct download or top-navigation flag — and the note is honest that "Popups escape the sandbox, and a Web popup retains its opener and can use that chain to navigate the top-level application" (line 19).
- Edge cases / failure handling: a rightmost toolbar toggle removes the sandbox attribute for that tab occurrence only — the mode is not persisted and renders a warning while active; the package performs **no** Host-side URL probe or proxy; the frame sends no referrer and adds no package-owned Permissions Policy.
- Surprising: "A parent page cannot inspect or drive a cross-origin iframe's internal history. The supported behavior must not imply that capability" — the decision states the limit up front rather than letting the UI imply it.

### .agents/notes/implemented/feature/2026-09-16-sidebar-browser.zh.md
- Chinese twin; its 决策 distinguishes the Web page's live browsing context from Document Preview's byte renderer.

### .agents/notes/implemented/feature/2026-09-16-sidebar-browser.i18n.yaml
- Hash sidecar for the sidebar-browser note's heading blocks.

### .agents/notes/implemented/feature/2026-09-17-sidebar-file-and-directory-auto-refresh.md
- Purpose: make Sidebar previews and file trees reflect disk state, including changes made outside Harness.
- Key abstractions: a `Resource` that holds **file metadata only**; `ResourceRegistry` owning subscriptions and retention; `useResource`; the Files panel's `filesFace` / `createFilesStore` retaining loaded levels and expansion state.
- Data flow: on-demand OS watching → resource metadata change → Document Preview compares Resource and content versions and reloads → the Files panel reconciles creation/deletion/renaming.
- Non-obvious design decisions: "Metadata updates and content reloads therefore remain separate responsibilities: the generic Resource acquires no content cache, and renderers do not directly manage filesystem watchers" (line 20); the Host's `fs/observed` events are insufficient because external editors and shell writes produce none.
- Edge cases / failure handling: reopening an expanded directory used to show old cached entries, which the retained store fixes.
- Surprising: the note opens with a four-row table naming exactly which starting surface had which gap (File Resource, Document Preview, workspace file events, Files panel) — a very cheap way to make a decision record auditable.

### .agents/notes/implemented/feature/2026-09-17-sidebar-file-and-directory-auto-refresh.zh.md
- Chinese twin; its 问题 table separates the File Resource, Document Preview, workspace file events and Files panel.

### .agents/notes/implemented/feature/2026-09-17-sidebar-file-and-directory-auto-refresh.i18n.yaml
- Hash sidecar for the sidebar-auto-refresh note's heading blocks.

### .agents/notes/implemented/feature/2026-09-19-windows-acl-mandatory-integrity-confinement.md
- Purpose: close the delete escape in the restricted-token Windows rung (issue #4581 — `cmd /c del` deleted outside the workspace in BOTH confined modes).
- Key abstractions: every grant applies three edits in one `SetNamedSecurityInfoW` call — the capability-SID allow ACE, a world-SID DENY on `FILE_DELETE_CHILD` with `CONTAINER_INHERIT_ACE`, and a Low mandatory label (`S-1-16-4096`, `SYSTEM_MANDATORY_LABEL_NO_WRITE_UP`, `OI|CI`) — plus `SetTokenInformation(TokenIntegrityLevel)` to lower the token to match.
- Data flow: grant → ACE + deny + label in one call → token lowered → any write or delete now has to clear the integrity policy inside the access check.
- Non-obvious design decisions: each piece is load-bearing and separately explained — the *label* is what reaches the parent-`FILE_DELETE_CHILD` route at all, the *deny* is what keeps one granted root out of another's reach (every granted root carries the Low label, so integrity alone would pass between them), and the deny is **container-only** because `0x40` is a member of `FILE_ALL_ACCESS` and a file-level copy would refuse every `GENERIC_ALL` open inside the root.
- Edge cases / failure handling: the label is *standing* on workspace roots (revoking it per session would re-propagate the whole tree and race concurrent sessions); `revokeWrite` clears it only when no other capability grant remains; the idempotent skip requires the exact ACE **and** the exact deny **and** the exact label, so a root granted by an earlier build picks the deny up on its next provision.
- Surprising: the flaw was invisible to writes — the intersection covered only the object's OWN security descriptor, and Windows separately authorizes a delete from the PARENT directory's `FILE_DELETE_CHILD` right, which no restricting SID has to co-sign.

### .agents/notes/implemented/feature/2026-09-19-windows-acl-mandatory-integrity-confinement.zh.md
- Chinese twin; its 问题 names issue #4581 and both `cmd /c del` and `[System.IO.File]::Delete`.

### .agents/notes/implemented/feature/2026-09-19-windows-acl-mandatory-integrity-confinement.i18n.yaml
- Hash sidecar for the mandatory-integrity note's heading blocks.

### .agents/notes/implemented/feature/2026-09-20-config-schema-dump-validation-policy.md
- Purpose: fix the contested meaning of `dsh --profile <name> --dump-config-schema`.
- Key abstractions: `x-cordis.complete`; the `x-cordis` diagnostics block; the collector's row walk.
- Data flow: Loader rows (including disabled ones) → Schemastery Config declarations → JSON Schema projection → stdout + exit code.
- Non-obvious design decisions: "Partial projection exits 1" — the exit code answers *whether the document can replace native validation*, not whether output was produced (line 13); discovery is declaration-oriented and **includes disabled rows**, because a disabled row is a declaration the user is likely to re-enable; and where native resolution can alter the input, the projection **widens** (keeps the declaration detail beside an unrestricted alternative) and records a limitation, "It never emulates the mutation" (line 15).
- Edge cases / failure handling: a disabled group or include without `group: true` never creates its children, so a missing carrier config is recorded as a childless tree and the entry schema does not validate its child declarations; native validation mutates its input, evaluates `!!js` and runs transform callbacks, so a static document cannot reproduce it.
- Surprising: the rationale for exiting non-zero is aimed at *editors and agents* consuming the schema — "a consumer feeding the schema to an editor or agent would treat an approximate document as authoritative" — and the widening is scoped so that only containers write adapted values back, so a bare primitive transform as an earlier union branch keeps `anyOf`.

### .agents/notes/implemented/feature/2026-09-20-config-schema-dump-validation-policy.zh.md
- Chinese twin; its 决策 fixes the meaning of `complete` and the exit code.

### .agents/notes/implemented/feature/2026-09-20-config-schema-dump-validation-policy.i18n.yaml
- Hash sidecar for the config-schema-dump note's heading blocks.

### .agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md
- Purpose: give Desktop a browsing surface that an iframe cannot provide.
- Key abstractions: `ElectronWebViewImpl` (guest leases and native navigation) + `ElectronWebviewPresentation` (creates the tag inside the Sidebar-owned container); `BrowserController` owning address commands and recoverable presentation state; controller registries keyed by DSH Session, independent of presentation bindings.
- Data flow: address command → guest → persisted address updated from the actual URL and title observations; rebinding replaces the store writer without recreating the page.
- Non-obvious design decisions: the Desktop Browser type declares `keepMounted` — the Sidebar retains DOM ancestors across hiding and docking while CSS owns layout and clipping; a physical unmount cancels pending attachment and releases the guest, and a later mount recreates it from the known address.
- Edge cases / failure handling: docking gestures disable guest pointer input; native history stays in the guest, so the persisted address is a presentation copy rather than a history store.
- Surprising: page lifetime and *storage* ownership are deliberately different owners — independent per-tab storage prevents related pages in one Workspace from sharing site login state, while a retained guest preserves the page.

### .agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.zh.md
- Chinese twin; its 问题 states that an iframe cannot expose cross-origin navigation or render sites that refuse embedding.

### .agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.i18n.yaml
- Hash sidecar for the desktop-browser-webview note's heading blocks.

### .agents/notes/implemented/feature/2026-09-20-spawn-agent-preset-selection.md
- Purpose: let a spawned child use an independent persona/tool/skill bundle without disturbing the implicit parent-preset join.
- Key abstractions: an explicit spawn preset id resolving the currently registered definition; the `agent-preset/selected` event; the `agentPreset` projection.
- Data flow: spawn with a preset id → the definition resolves live → an independently selected child records `agent-preset/selected` **before** its first own `subagent/descriptor`; cold restoration excludes the inherited fork prefix and uses that ordering to identify independent selection, then reads the id from the projection.
- Non-obvious design decisions: omission joins the parent's exact live revision, preserving its plugin instances even after the declaration changes or is removed; a missing projection rejects restoration rather than silently switching to the parent's composition.
- Edge cases / failure handling: "A creation header can contain an inherited preset id, while a fork's seed can contain an ancestor's selection and an old child can record a selection after its descriptor. None of these facts establishes independent selection at child creation" — the ordering marker is the discriminator, with no new descriptor field and no new event type.
- Surprising: this reuses an *existing* event type rather than minting one, because the ordering is what distinguishes an independent selection from historical child logs.

### .agents/notes/implemented/feature/2026-09-20-spawn-agent-preset-selection.zh.md
- Chinese twin; its 决策 explains why an ordering marker beats a new descriptor field.

### .agents/notes/implemented/feature/2026-09-20-spawn-agent-preset-selection.i18n.yaml
- Hash sidecar for the spawn-agent-preset-selection note's heading blocks.

### .agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.md
- Purpose: stop archiving from hiding a Session that is still spending tokens.
- Key abstractions: two capability seams owned by the registry — `workspace/session-activity` (waterfall: "what still runs?") and `workspace/session-stop` (parallel: "stop it"); providers register on the root, so the workspace package knows no agent/job/schedule vocabulary.
- Data flow: `archiveSession(sessionId)` → activity answer → refuse with `WorkspaceActiveSessionError` / API `workspace/session-active` (carrying families with item ids and labels) → on `stopActivity: true` the archive is written **first**, then the stop event is dispatched (never awaited to settlement) → the API Session Controller's `agent/pre-step` listener rejects any step proposed for an archived Session or its subagent descendants.
- Non-obvious design decisions: the stop order matters — "the durable archive set is what the pre-step gate reads, so every wake a stop induces … is already blocked" (line 16); the stop is the *user's* stop (`agent.cancel({ kind: 'user' })`, which discards queued input with a logged inbox splice); each provider owns exactly the vocabulary it already has.
- Edge cases / failure handling: a stop that fails is a logged warning, not a reason to undo the archive; a refused archive opens a stop-and-archive dialog whose list comes from the Host's answer, not a client-side mirror, so the dialog names exactly what will be stopped; unarchiving lifts the gate but does not resume the stopped work.
- Surprising: the Schedule provider deletes reminders from the **stored task rows**, not a fold of the live Session log, because a Host task outlives its Session's Agent — that is the follow-up note.

### .agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.zh.md
- Chinese twin; its 决策 names the four activity families (turn / job / subagent / schedule).

### .agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.i18n.yaml
- Hash sidecar for the archive-stops-running-work note's heading blocks.

### .agents/notes/implemented/feature/2026-09-22-archive-admission-reads-stored-tasks.md
- Purpose: make archive admission see the reminders a cold Session would still fire.
- Key abstractions: `ScheduleRuntime.activeRecords()` is **gone**; the stored Host task table is the only place a due reminder can be seen.
- Data flow: `workspace/session-activity` → `list({ sessionId })` (rows bound to that Session whose status is active) → reported as the `schedule` family, one item per task with stored id and title, prepended to `next()` so other providers keep their entries; `workspace/session-stop` removes those rows directly inside one slot of the same serialized queue the tools use.
- Non-obvious design decisions: "Session liveness is never consulted: an idle or cold Session whose stored rows are armed refuses the archive" (line 13); the stop removes the rows itself because re-entering the serialized queue from inside the slot that holds it deadlocks.
- Edge cases / failure handling: the stop attempts every row (a row left armed would still fire) and notifies observers for the rows that landed before the first failure reaches the caller; both listeners are registered in one effect (`schedule.archiveAdmission()`) so unloading the plugin withdraws them together.
- Surprising: the failure mode the note fixes is a *silent* archive of a cold Session whose armed reminder then dispatches into a turn the pre-step gate ends as `blocked` — consuming the occurrence without a model step.

### .agents/notes/implemented/feature/2026-09-22-archive-admission-reads-stored-tasks.zh.md
- Chinese twin; its 决策 explains the deadlock that makes the public management `delete` path unusable from inside the slot.

### .agents/notes/implemented/feature/2026-09-22-archive-admission-reads-stored-tasks.i18n.yaml
- Hash sidecar for the archive-admission-stored-tasks note's heading blocks.

### .agents/notes/implemented/feature/2026-09-24-auto-review-user-approval-fallback.md
- Purpose: let a human override a reviewer's denial, and tell a technical failure apart from a policy decision.
- Key abstractions: the tools pipeline's existing `ask` decision; the approval service's `allowed-once` / `rejected` / `cancelled` / `unavailable` outcomes.
- Data flow: reviewer denies → `ToolRuntime` sends the approval request with the reason `Auto review denied tool "<name>"` (plus `: <reviewer reason>`) → `allowed-once` executes the call, the other outcomes deny it through the ordinary approval messages and the body does not run.
- Non-obvious design decisions: the ask happens **only after** later `tools/pre-execute` listeners have allowed the call, "so a downstream denial or cancellation wins without prompting" (line 13); selecting Auto writes `danger-full-access` with the `ask` approval policy, and a delegated in-process child pins `never` so a child Auto keeps the final `AutoReviewDeniedError` denial.
- Edge cases / failure handling: a reviewer **failure** is a different message entirely — `Auto review of tool "<name>" failed; its body was not executed: <error>` — carrying the finish kind, failure code and provider message, with no structured error info; asking the user after a failure is rejected because "a failure says nothing about the action's risk".
- Surprising: the whole fallback exists because a single failure mode forced users to switch the *entire* Session to Full access — the granularity of the escalation path is the actual product defect.

### .agents/notes/implemented/feature/2026-09-24-auto-review-user-approval-fallback.zh.md
- Chinese twin; its 决策 distinguishes a policy denial from a technical failure.

### .agents/notes/implemented/feature/2026-09-24-auto-review-user-approval-fallback.i18n.yaml
- Hash sidecar for the auto-review-fallback note's heading blocks.

### .agents/notes/implemented/feature/2026-09-24-session-inspector.md
- Purpose: debug a Session with its raw log, Chat structures and rendered conversation side by side.
- Key abstractions: the experimental `session-inspector-log` Sidebar page; a virtual table grouping Turn → Step → event → Assistant block/delta; WeakMap references for Node, Group, Data roots and Turn/Step locations.
- Data flow: the Sidebar owns the Session reference (the Inspector adds no resource provider, header slot, composer or product navigation API); only the selected table subscribes, using the existing loaded window and pagination; picking uses a real click-catching mask over Chat, resolving the underlying record via `elementsFromPoint()`.
- Non-obvious design decisions: "Breadcrumbs retain readers rather than copies" and Node Data can expand inline, with named references and ancestor detection stopping recursive expansion (line 19); object fields are read lazily in pages of 50 entries; getters never run automatically; weak collections stay opaque.
- Edge cases / failure handling: conversation publications invalidate expanded-field caches because Location Data readers can mutate without changing identity; log rows may map only approximately to a nearby loaded Node/Group/Turn; navigation never switches the main View or loads history; the Inspector does not write Chat's fold state.
- Surprising: the mask "prevents its click action and forwards wheel movement to existing scrollports" — the debugging tool must not steal the product's own input.

### .agents/notes/implemented/feature/2026-09-24-session-inspector.zh.md
- Chinese twin; its 决策 explains that runtime objects share Node/Turn/Step identities and contain cycles.

### .agents/notes/implemented/feature/2026-09-24-session-inspector.i18n.yaml
- Hash sidecar for the session-inspector note's heading blocks.

### .agents/notes/implemented/feature/2026-10-02-plugin-market-discover.md
- Purpose: let a user choose index sources and browse installable bundles without shipping an official market.
- Key abstractions: a Host `pluginMarket` service (requires `pluginManager` for read-only calls, never writes the profile); a **volatile** `indexes` configuration field; the `search` / `entry` operations.
- Data flow: user edits `indexes` → the Loader commits a volatile-only change into the running reference *without remounting* any plugin → the Host fetches through the process proxy, refuses redirects, bounds the body (default 128 MiB) and validates with the shared format package.
- Non-obvious design decisions: "The Host fetches through the process proxy, refuses redirects, bounds the body, and validates with the shared format package; an invalid index affects only its own URL"; `search` filters, matches, orders and pages **on the Host** and returns at most 100 entries — clients never receive or filter a whole index; each page carries its document's `fetchedAt`, so a later page sent with it is answered from that cached document and paging stays consistent across cache expiry.
- Edge cases / failure handling: `file:` is excluded from index URLs because relative icon references would resolve to URLs a browser cannot load; `search`/`entry` accept only a configured URL, so the Host never fetches a client-supplied address; a blank or unparseable base leaves both providers unavailable.
- Surprising: text matching is multilingual without a word dictionary — a CJK run is indexed as overlapping character pairs plus its last character — and MiniSearch builds the index on the first text query of each document and yields between chunks.

### .agents/notes/implemented/feature/2026-10-02-plugin-market-discover.zh.md
- Chinese twin; its 决策 explains that index sources are user data and the Host never fetches a client-supplied address.

### .agents/notes/implemented/feature/2026-10-02-plugin-market-discover.i18n.yaml
- Hash sidecar for the plugin-market-discover note's heading blocks.

### .agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md
- Purpose: let a market publish one index document a list page can render without per-row fetches.
- Key abstractions: one JSON index format (`dsh-plugin-market-index` is the executable rule set), reusing npm's package names, versions, ranges, distribution tags and person declarations.
- Data flow: index → reader/generator (separate concerns) → a Discover page or the `plugin_market` tool → guided installation.
- Non-obvious design decisions: the **index** is separate from the **index generator** — "How an index is produced, and from which source list, belongs to the generator"; additional fields or changed meanings require a plugin-market requirement that npm does not meet, so the format piggybacks on npm's maintained parsers and validators.
- Edge cases / failure handling: markets may publish their own categories, tags, downloads and ratings without DSH knowing what those values mean.
- Surprising: the smallest possible index (one npm name per line) was rejected precisely because a client rendering it would have to fetch each package's manifest, locale files and icon — "a list page that issues one or more requests per row is slow, fails partially, and puts metadata resolution in every client".

### .agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md
- Chinese twin; its 问题 explains why a bare npm-name list is too slow to render.

### .agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.i18n.yaml
- Hash sidecar for the plugin-market-index-format note's heading blocks.

### .agents/notes/implemented/feature/2026-10-14-built-in-plugin-feature-previews.md
- Purpose: show a picture of what a built-in bundle produces.
- Key abstractions: a name→`{ en, zh }` image map inside `PluginManagerPage.tsx`; images under `packages/client/ui-plugin-manager/src/client/assets/`, embedded as data URLs by the shared client tsdown preset.
- Data flow: the bundle details page shows the image for the current UI language below the description and status notices, whether or not the bundle is enabled.
- Non-obvious design decisions: "Every built-in feature preview is an entry in this map. Packages cannot declare a preview, so the map is not a plugin-author interface and can change without a compatibility path" (line 13).
- Edge cases / failure handling: the map lives in the same file, with the same hardcoding, that defines the optional bundle lists.
- Surprising: a `preview` field in the package manifest was rejected because "one official bundle has artwork, which does not justify a public format" — the note explicitly weighs a one-off need against a permanent contract.

### .agents/notes/implemented/feature/2026-10-14-built-in-plugin-feature-previews.zh.md
- Chinese twin; its 决策 rejects a `preview` manifest field as a premature public contract.

### .agents/notes/implemented/feature/2026-10-14-built-in-plugin-feature-previews.i18n.yaml
- Hash sidecar for the built-in-plugin-feature-previews note's heading blocks.

### .agents/notes/implemented/feature/2026-10-14-host-release-change-refresh-prompt.md
- Purpose: tell a stale browser page to reload instead of hot-replacing plugins across releases.
- Key abstractions: "a release is the Host's version identity: a version plus an optional source commit"; client-hmr hot-replaces plugins by each row's `rev` (bundle mtime/ctime/size); the API connection validates its ready frame against an exact key set.
- Data flow: page reconnects to a new Host → receives the new Host's complete graph → the page learns the Host now runs another release → it prompts for a reload.
- Non-obvious design decisions: the name is deliberately "release", not "build", because "build" names the build process and its artifacts; Desktop is unaffected because after its Host is replaced the main process navigates the window again.
- Edge cases / failure handling: the Vite shell, static libraries and bootstrap are never replaced during the page's lifetime, so a protocol change leaves the page permanently failing to reconnect — "The API connection validates its ready frame against an exact key set, so an old page cannot recover from a protocol change by itself."
- Surprising: the note distinguishes what the client-plugin HMR receiver *can* reload (plugins, by `rev`) from what it cannot (the shell), and refuses to pretend the page can heal itself.

### .agents/notes/implemented/feature/2026-10-14-host-release-change-refresh-prompt.zh.md
- Chinese twin; its 问题 lists the four technical causes, ending "Desktop is unaffected".

### .agents/notes/implemented/feature/2026-10-14-host-release-change-refresh-prompt.i18n.yaml
- Hash sidecar for the host-release-refresh-prompt note's heading blocks.

### .agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.md
- Purpose: run DeepSeek retrieval without an auxiliary model request per query.
- Key abstractions: `deepseek-search-api` and `deepseek-fetch-api` registered behind the existing `web_search` / `web_fetch` tools; `web.searchProvider` + `web.fetchProvider` written together by one settings switch.
- Data flow: the switch (default OFF) → both providers resolve one settings snapshot including endpoint and credentials → Search returns structured sources, Fetch returns Markdown mapped onto the existing fetch-result fields.
- Non-obvious design decisions: the two protocols keep **independent API bases** — Messages stays `https://api.deepseek.com/anthropic/v1` + `/messages`, direct retrieval uses `web-deepseek-api.baseURL` (default `https://api.deepseek.com/v1/tools`) + `/search` or `/fetch` — "These prefixes are different and are never inferred from the hostname"; the switch is the explicit opt-in, so the documented public deployment serves as its default.
- Edge cases / failure handling: a blank or unparseable base leaves both providers unavailable; requests send only the documented authorization and JSON content type; a Session on the DeepSeek account route sends its account token instead (accepted by the public routes on 2026-10-16); an Anthropic-compatible gateway that serves Messages web search but has no `/v1/tools` routes keeps Messages search.
- Surprising: the auxiliary-model-request waste was found by noticing that the harness "extracts sources and citation excerpts but discards the generated answer" — the dedicated API returns what the harness actually wanted.

### .agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.zh.md
- Chinese twin; its 决策 states the two protocols keep independent API bases.

### .agents/notes/implemented/feature/2026-10-15-deepseek-search-fetch-api.i18n.yaml
- Hash sidecar for the deepseek-search-fetch-api note's heading blocks.

### .agents/notes/implemented/process/2026-07-06-node-engine-floor.md
- Purpose: set the Node engine floor so `pnpm install --engine-strict` succeeds at the advertised LTS.
- Key abstractions: root `engines.node = ^22.19.0 || >=24.0.0`; the keyless CI matrix `['22.19', 24, 26]`.
- Data flow: engine declaration → dependency `engines.node` compatibility → install under `--engine-strict`.
- Non-obvious design decisions: two Node features gate the source runtime — `node:sqlite` (flag-free from 22.13 / 23.4) and native TypeScript type-stripping (default from 22.18 / 23.6); the primary Node 24 jobs own the complete typecheck and unit-coverage inventory while every version runs focused smokes only.
- Edge cases / failure handling: the real-API e2e workflow stays on Node 24 because it exercises API integration rather than the runtime floor.
- Surprising: the floor is a *workspace* contract, not merely an API surface — "a contract for the installed workspace, not only for the runtime APIs the harness source calls directly".

### .agents/notes/implemented/process/2026-07-06-node-engine-floor.zh.md
- Chinese twin; its 决策 names the two Node features that gate the source runtime.

### .agents/notes/implemented/process/2026-07-06-node-engine-floor.i18n.yaml
- Hash sidecar for the node-engine-floor note's heading blocks.

### .agents/notes/implemented/process/2026-07-21-serial-cross-platform-ci-reference.md
- Purpose: give reviewers a direct answer to "what does the complete primary CI aggregate do on each hosted OS?".
- Key abstractions: the required Linux/Windows aggregate jobs; a separate serial reference workflow.
- Data flow: master push → the serial reference re-proves the complete unsharded aggregate on each selected hosted OS.
- Non-obvious design decisions: "Those jobs still should not be the only completeness oracle: a defect in their gate inventory or dependency graph could omit work while the required aggregate stays green"; encoding the one-minute non-Windows / three-minute Windows targets as job *timeouts* was rejected because hosted-runner startup variance can cancel a correct gate before it emits diagnostics.
- Edge cases / failure handling: real-kernel sandbox proofs need specific hosted OSes but do not give a merge verdict, so repeating that four-job matrix on every PR consumes capacity without satisfying branch protection.
- Surprising: the note separates a *performance objective* (needs measurement against GitHub timestamps) from a *correctness objective* (needs enough time to finish) — a distinction most CI notes conflate.

### .agents/notes/implemented/process/2026-07-21-serial-cross-platform-ci-reference.zh.md
- Chinese twin; its 问题 explains why encoding performance targets as timeouts is a separate failure mode.

### .agents/notes/implemented/process/2026-07-21-serial-cross-platform-ci-reference.i18n.yaml
- Hash sidecar for the serial-cross-platform-CI note's heading blocks.

### .agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md
- Purpose: recover from a hosted-pool outage without needing a merge to do it.
- Key abstractions: two independent writer-manageable repository variables, `DSH_CI_FAILOVER_LINUX` and `DSH_CI_FAILOVER_WINDOWS`; values `selfhosted` (in-house `vm-backup` / `dsh-win-ci`) and `blacksmith`.
- Data flow: outage → a repository writer sets the switch → the participating jobs resolve a different runner → the verdict job follows its workers so it does not remain queued on an unavailable pool.
- Non-obvious design decisions: "A platform switch does not redirect the other platform"; the node-compatibility jobs require a same-repository, non-fork head and a non-Dependabot author, while the blacksmith branch carries none of those predicates; under `selfhosted`, Linux failover bounds snapshot concurrency and skips hosted package-cache restores.
- Edge cases / failure handling: an outage needs a switch any responder with repository write access can throw without merging anything — the deadlock is that the required checks gate the very merge that would fix them; a cancelled or merely scheduled standby drill is not readiness evidence (check the last completed verdict's age and commit).
- Surprising: the note is candid that a broader GitHub-hosted capacity failure still blocks `all checks passed` via the `node-24-bench`, `python-sdk` and `python-runtime` dependencies on standard runners.

### .agents/notes/implemented/process/2026-07-26-ci-failover-runbook.zh.md
- Chinese twin; its 问题 states the outage deadlock explicitly.

### .agents/notes/implemented/process/2026-07-26-ci-failover-runbook.i18n.yaml
- Hash sidecar for the CI-failover-runbook note's heading blocks.

### .agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.md
- Purpose: end the unstated "avoid new dependencies" reflex that agents were inferring from the repo's tiny dependency list.
- Key abstractions: a stated bar for a new dependency — net deletion, health, and no new capability surface.
- Data flow: decision → swap a hand-rolled surface (SSE parsers, protocol framers, retry loops, glob matchers) for a maintained package, judged by what the repo stops owning.
- Non-obvious design decisions: "Introducing an external dependency is a legitimate simplification, not a policy exception"; deliberate exceptions are named — vendored Cordis, the twin LLM adapters, schemastery as the config-schema standard — so the policy does not sweep them away.
- Edge cases / failure handling: "A dep that only adds capability is a feature decision, not a simplification"; the swap must shrink owned code, tests *and* contract surface, "rather than merely relocate complexity behind a wrapper".
- Surprising: the diagnosis is about the *documentation* gap: "Nothing in `AGENTS.md` actually stated a dependency policy, so agents inferred one from the existing pattern, and the inferred rule … is stricter than anyone decided."

### .agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.zh.md
- Chinese twin; its 问题 names the unstated reflex agents inferred from the repo pattern.

### .agents/notes/implemented/process/2026-07-26-dependencies-over-hand-rolling.i18n.yaml
- Hash sidecar for the dependencies-over-hand-rolling note's heading blocks.

### .agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.md
- Purpose: draw a retention boundary for a note corpus that carries a maintenance obligation for every path, symbol, default, translation and link.
- Key abstractions: the archive path `.agents/notes/archived/{kind}/yyyy-mm-dd-topic.md`; the `Archived: YYYY-MM-DD` metadata line; the `.rgignore` exclusion.
- Data flow: a note is judged (small UI adjustment / mechanical change → delete as a complete triplet; shipped-complete + low-future-value + historical value → archive); the complete EN/ZH/sidecar triplet moves together.
- Non-obvious design decisions: "Implemented notes that only describe small UI adjustments or purely mechanical changes are deleted as complete triplets, with inbound links repaired or removed" (line 13) — deletion, not archival, is the default for trivia; "Foundational boundaries, durable and wire semantics, security rules, recurring design temptations, and unresolved reintroduction conditions remain active regardless of age or word count."
- Edge cases / failure handling: archival admission checks lifecycle metadata and completeness, "not title punctuation, blank-line layout, or language-switcher wording; requiring those repairs would rewrite the historical record"; proposed notes never enter the archive (an obsolete proposal becomes rejected); a rejected note lives only while it prevents a tempting, meaningful mistake.
- Surprising: "Relocation, that metadata line, the corresponding sidecar re-record, and mechanical inbound-link repair are the only permitted archival edits" — an archive move may not tidy the text.

### .agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.zh.md
- Chinese twin; its 决策 names the permitted archival edits.

### .agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.i18n.yaml
- Hash sidecar for the frozen-agent-note-archive note's heading blocks.

### .agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.md
- Purpose: stop a `pnpm install` in one worktree from rewriting the hooks every other worktree uses.
- Key abstractions: `extensions.worktreeConfig`; an absolute `core.hooksPath` at `$GIT_DIR/dsh-hooks`; a repository-scoped lock (process id, random token, file identity and exact contents).
- Data flow: `postinstall` → `install-lefthook.mjs` → (CI env → return before Git discovery) → format-0 → format-1 upgrade → enable worktree config → assign the worktree's hooks path → write hooks under the lock.
- Non-obvious design decisions: the installer refuses direct common-config `extensions.*`, direct `core.worktree`, `core.bare=true` and non-empty dormant worktree configs, because enabling the extension would activate them; and it disables include expansion, since Git's repository-format parser also ignores included targets.
- Edge cases / failure handling: dead or invalid locks require manual recovery rather than automatic breaking; on Windows, acquiring or inspecting a lock retries EPERM within the existing 30-second deadline because deleting a lock temporarily denies access while readers close their handles; the lock is released only when process id, token, file identity *and* exact contents all still match.
- Surprising: the migration removes a direct `core.bare=false` because false is Git's default — a one-line deletion with a stated reason.

### .agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.zh.md
- Chinese twin; its 问题 explains that linked worktrees share the common repository's hooks directory.

### .agents/notes/implemented/process/2026-07-27-worktree-local-lefthook.i18n.yaml
- Hash sidecar for the worktree-local-lefthook note's heading blocks.

### .agents/notes/implemented/process/2026-07-30-generated-third-party-notices.md
- Purpose: keep the third-party disclosure complete and true as dependencies change.
- Key abstractions: `THIRD_PARTY_NOTICES.md` generated by `scripts/gen-third-party-notices.ts` from the workspace manifests, `vendor/README.md`, the `pyproject.toml` files, `pnpm-workspace.yaml` and the shared runtime lock.
- Data flow: generator inputs → generated file → committed → the freshness assertion inside `scripts/gen-third-party-notices.spec.ts`, which the test lane already runs.
- Non-obvious design decisions: "The test lane enforces freshness … the check adds no gate process, no scheduler slot, and no separate CI step" (line 13); no Git hook regenerates it because "browser inputs make every package source file a generator input, so a hook would run the 16-second generator on nearly every commit".
- Edge cases / failure handling: the disclosure has to say which packages end up on a user's machine and which only build and test the repository — a hand-written inventory answered none of that durably.
- Surprising: the note's opening premise is that a hand-written list "drifts silently the moment a package is added, removed, or relicensed, and nothing would notice" — a stated, mechanical anti-drift argument for generated docs.

### .agents/notes/implemented/process/2026-07-30-generated-third-party-notices.zh.md
- Chinese twin; its 问题 says a hand-written list cannot stay true.

### .agents/notes/implemented/process/2026-07-30-generated-third-party-notices.i18n.yaml
- Hash sidecar for the generated-third-party-notices note's heading blocks.

### .agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.md
- Purpose: give dependent PR chains an official stack identity.
- Key abstractions: GitHub's native stack object; `PullRequest.stack` / `stackEntry.position` as authoritative.
- Data flow: an unstacked same-author chain → `gh stack link` (bottom-to-top) → `gh stack merge <stack-number> --yes --merge`; a partial landing names an explicit boundary PR and merges the bottom prefix through it.
- Non-obvious design decisions: "The workflow never falls back to per-PR `gh pr merge` and manual retargeting"; mixed/unavailable authors and cross-fork chains require user confirmation or hard-stop; conflicting existing stack membership needs user direction before anything is dissolved.
- Edge cases / failure handling: a merge queue may process the selected PRs in separate groups, so every selected PR must independently reach `MERGED` before the landing is complete; a direct native merge is all-or-nothing.
- Surprising: a blanket ban on rewriting reviewed branches was relaxed *only* for the native stack sync workflow, because otherwise standalone and stacked PRs would have inconsistent history choices.

### .agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.zh.md
- Chinese twin; its 问题 contrasts base-branch-only chains with GitHub's native stacked-PR object.

### .agents/notes/implemented/process/2026-08-02-native-github-stacks-and-optional-rebases.i18n.yaml
- Hash sidecar for the native-github-stacks note's heading blocks.

### .agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.md
- Purpose: prove Windows correctness natively before merge, because Wine cannot.
- Key abstractions: three per-PR native jobs (`windows-build`, `windows-coverage`, `windows-native-tests`); a master-only `windows node 24 / wine` job.
- Data flow: PR → Developer Mode enabled for symlinks → pinned pnpm via `pnpm/action-setup` → immutable install without a transferred store archive → the inventory run under native PowerShell.
- Non-obvious design decisions: "Wine checks the win32 toolchain over a Linux kernel and case-sensitive ext4 … It cannot prove NTFS, DACL, ConPTY, crash durability, or native process behavior"; the native Windows lane must execute the *complete* supported source inventory at the same 100 %-per-file threshold because a coverage audit found stale branch state had restored temporary LSP exclusions.
- Edge cases / failure handling: nodejs.org remains the version and SHA-256 authority even when a transport mirror resumes the bytes, and the archive is never promoted before the checksum passes; per-job deadlines range 60–120 minutes.
- Surprising: Blacksmith build/coverage jobs request 16 vCPU while file-serial native tests request 2 — capacity is chosen by the shape of the work, not by the platform.

### .agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.zh.md
- Chinese twin; its 问题 states that the coverage audit found restored temporary LSP exclusions.

### .agents/notes/implemented/process/2026-08-08-native-windows-pull-request-ci.i18n.yaml
- Hash sidecar for the native-windows-PR-CI note's heading blocks.

### .agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.md
- Purpose: stop PR labels from mixing "what kind of change" with "which domains it affects".
- Key abstractions: one canonical `kind/*` label plus at least one materially affected `area/*` label per open or merged PR; a separate Issue Type and source taxonomy.
- Data flow: PR labels → queries and routing; closed-unmerged PRs keep migrated historical assignments but receive no invented classification.
- Non-obvious design decisions: "Operational labels may coexist without satisfying either dimension"; a closed area inventory is rejected because it "forces new domains into inaccurate categories".
- Edge cases / failure handling: reusing PR kind/source labels on Issues is rejected as duplicated metadata that "weakens the meaning of each family".
- Surprising: the taxonomy is explicitly two-dimensional and the note treats "materially affected" as a judgement, with the constraint that historical PRs are never retro-classified.

### .agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.zh.md
- Chinese twin; its 问题 separates the two label dimensions.

### .agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.i18n.yaml
- Hash sidecar for the github-label-taxonomy note's heading blocks.

### .agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.md
- Purpose: make the Issue Project status express *who owns the next step*.
- Key abstractions: `pull_request.review_requested` → `In review`; `pull_request_review.submitted` with `review.state == 'changes_requested'` → `In progress`.
- Data flow: webhooks → lifecycle commands → Project status; approved/commented submissions allocate no lifecycle runner, dismissed reviews are not subscribed.
- Non-obvious design decisions: "The submitted event remains necessary because a reviewer can request changes without an earlier review-request event"; a monotonic projection cannot move an automation-owned Issue back from `In review` to `In progress`, and reconstructing review rounds would add state the two-event contract does not need.
- Edge cases / failure handling: changes-requested can move `In review` back **only** when the latest status event for the target Project was written by the configured lifecycle actor; "A human or unknown latest actor preserves the current status."
- Surprising: ordinary PR events remain forward-only implementation signals that "cannot move `In review` backward" — the status is a handoff ledger, not a mirror of GitHub's aggregate review state.

### .agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.zh.md
- Chinese twin; its 问题 explains that aggregate PR review state cannot represent a handoff.

### .agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.i18n.yaml
- Hash sidecar for the event-directed-PR-status note's heading blocks.

### .agents/notes/implemented/process/2026-08-10-npm-release-sequences.md
- Purpose: publish three unrelated package groups without dragging each other along.
- Key abstractions: three independent sequences — `packages/*/*` + `apps/*` (the `@deepseek-ai/dsh` runtime surface), `vendor/*` (nine rescoped Cordis packages), `native/system/packages/*` (Linux platform packages).
- Data flow: each sequence has its own version baseline, change rate and build requirements; dsh moves with the product, vendor only on an upstream re-sync, native needs a musl toolchain and one build per architecture.
- Non-obvious design decisions: 933 hand-written `peerDependencies: "^0.0.1"` entries between sibling dsh packages had to go — `^0.0.1` means `>=0.0.1 <0.0.2`, which excludes `0.0.2`, and semver excludes prereleases from a range without a prerelease of its own — "Those entries never failed only because the version never left `0.0.1`"; all 217 workspace manifests also set `private: true`, which npm refuses to publish.
- Edge cases / failure handling: `scripts/publish-npm-baseline.ts` stays a *local* script (it packs and publishes in one process, needs a human to authenticate and retry, and excludes vendor) and cannot be the CI basis, though its tarball payload validation and installed-artifact probes are kept.
- Surprising: the note separates the version *semantics* failure from the packaging failure and treats "the version never left 0.0.1" as the reason a real defect hid for so long.

### .agents/notes/implemented/process/2026-08-10-npm-release-sequences.zh.md
- Chinese twin; its 问题 records the `private: true` and `^0.0.1` peer-range blockers.

### .agents/notes/implemented/process/2026-08-10-npm-release-sequences.i18n.yaml
- Hash sidecar for the npm-release-sequences note's heading blocks.

### .agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md
- Purpose: remove one ten-letter token that had accumulated eight unrelated meanings.
- Key abstractions: a blanket ban on the token in any case variant across maintained tracked paths and text.
- Data flow: each occurrence is replaced with the exact local concept — source-event references, provider metadata, model identity, context producer, configuration source, artifact identity, recorded evidence.
- Non-obvious design decisions: the existing concrete-prose policy "required sentence-level classification and normally preserved identifiers", which improved sentences but "allowed the same ambiguous label to remain in APIs, durable compatibility fixtures, filenames, generated catalogs, and new prose" (line 9).
- Edge cases / failure handling: the ban covers identifiers too, not just prose — the strongest version of the rule.
- Surprising: a vocabulary rule enforced over *code, filenames and generated catalogs* — the same class of mistake the note is about is the one the prose policy could not catch.

### .agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.zh.md
- Chinese twin; its 问题 lists the eight unrelated meanings the token had accumulated.

### .agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.i18n.yaml
- Hash sidecar for the ambiguous-origin-label note's heading blocks.

### .agents/notes/implemented/process/2026-08-26-published-dependency-faces.md
- Purpose: make the published CLI cheap to install.
- Key abstractions: three distinct npm sections — a browser bundle, a Host entry, shared TypeScript declarations — plus Cordis injection metadata, each declared in the section that matches who loads it.
- Data flow: publish → npm installs peers automatically and re-evaluates placement through deep, converging peer paths → the CLI's install cost.
- Non-obvious design decisions: "The package that chooses a Client build input is the shipped profile, while a Host value import is loaded by Node from the importing package. Those relationships need different npm sections."
- Edge cases / failure handling: making peers optional or changing their ranges does not remove the traversal; applying one rule to every Host package would shrink the graph but create a large migration with no installation benefit.
- Surprising: the failure mode is not a version conflict but npm's *peer traversal* — a cost that shows up only at install time and is invisible in the source tree.

### .agents/notes/implemented/process/2026-08-26-published-dependency-faces.zh.md
- Chinese twin; its 问题 names the peer-traversal install cost.

### .agents/notes/implemented/process/2026-08-26-published-dependency-faces.i18n.yaml
- Hash sidecar for the published-dependency-faces note's heading blocks.

### .agents/notes/implemented/process/2026-09-06-python-runtime-windows-hosted.md
- Purpose: keep the Windows Python runtime CI on hosted runners after the self-hosted migration proved worse.
- Key abstractions: the `matrix.runner` in `build-exe-for-python-sdk.yml`; the removal of the failover selector, the job-private Python setup, the self-hosted install/post-step cleanup and the routing spec.
- Data flow: PR → hosted `windows-2025` → setup-python → pnpm cache restore → pkg cache → wheel smoke.
- Non-obvious design decisions: the note argues from *three same-day failures* (09:12 pass on `dsh-win-ci-16`, 10:06 and 10:46 failures on `-21` and `-04`, plus an 11:29 rerun repeating the silent death) while Linux and macOS cells passed in the same run — and states that the migration proposal remained `proposed` because its acceptance criteria were never measured.
- Edge cases / failure handling: the UTF-8 mode exports existed because the persistent host used a GBK default code page; hosted images provide the locale the lane previously ran under, so the exports are removed with the host.
- Surprising: `DSH_CI_FAILOVER_WINDOWS=selfhosted` again retargets *only* the native Windows jobs — the failover scope is stated per-job-type, not per-platform.

### .agents/notes/implemented/process/2026-09-06-python-runtime-windows-hosted.zh.md
- Chinese twin; its 问题 gives the exact run IDs, times and the silent `dsh plugin add` child exit.

### .agents/notes/implemented/process/2026-09-06-python-runtime-windows-hosted.i18n.yaml
- Hash sidecar for the python-runtime-windows-hosted note's heading blocks.

### .agents/notes/implemented/process/2026-09-09-blacksmith-failover-leg.md
- Purpose: add a third CI failover leg without moving trust-boundary jobs by default.
- Key abstractions: `DSH_CI_FAILOVER_LINUX` / `_WINDOWS` additionally accept the value `blacksmith`; per-job vCPU sizes.
- Data flow: writer sets the switch → participating jobs retarget onto Blacksmith runners at their configured vCPU; any other value keeps today's runner.
- Non-obvious design decisions: "the blacksmith branches carry no Dependabot exclusion: Blacksmith runners are ephemeral, so the persistent-VM rationale that keeps Dependabot on the hosted pool does not apply"; the 64/96-core benchmark rows keep fleet labels because Blacksmith offers no such tier; the python-runtime builder stays hosted in full because it passes real-API credentials and feeds the PyPI chain.
- Edge cases / failure handling: it "costs money only while set, which is why it is an explicit outage or experiment choice, never the default."
- Surprising: the wholesale `runs-on` replacement proposed by Blacksmith's wizard was rejected on three grounds at once — it breaks the workflow contract specs, distorts benchmark/performance-budget measurements, and moves trust-boundary jobs without a decision record.

### .agents/notes/implemented/process/2026-09-09-blacksmith-failover-leg.zh.md
- Chinese twin; its 问题 rejects Blacksmith's wholesale `runs-on` replacement as the default.

### .agents/notes/implemented/process/2026-09-09-blacksmith-failover-leg.i18n.yaml
- Hash sidecar for the blacksmith-failover-leg note's heading blocks.

### .agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.md
- Purpose: stop two Apple submissions from serialising.
- Key abstractions: one assembled App, two `ditto` copies; one electron-builder process per lane with `--prepackaged`, an isolated output directory and `--publish never`.
- Data flow: fixed-target installer → assemble App → write and verify `app-update.yml` → sign → copy ×2 → App lane notarizes/staples/verifies and builds the ZIP; DMG lane verifies, packages, signs the image and notarizes/staples/verifies the image.
- Non-obvious design decisions: writing the update config explicitly is required "because electron-builder skips its macOS update-config hook when the initial build has only the directory target, while the later `--prepackaged` invocations do not reassemble the App"; the ZIP contains an individually stapled App while the DMG's signed App is not individually stapled because the outer ticket covers the nested code (Apple's container guidance).
- Edge cases / failure handling: stapling modifies the App, which is exactly why the two lanes cannot share a writable directory.
- Surprising: independent extraction of the unstapled App relies on an online or cached ticket — the ZIP supplies an embedded one — so the two artifacts have *different* offline behaviour by design.

### .agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.zh.md
- Chinese twin; its 问题 explains that stapling modifies the App so the lanes cannot share a directory.

### .agents/notes/implemented/process/2026-09-09-parallel-macos-notarization.i18n.yaml
- Hash sidecar for the parallel-macos-notarization note's heading blocks.

### .agents/notes/implemented/process/2026-09-11-persistence-type-history.md
- Purpose: make persistence-type change reviewable, not merely detectable.
- Key abstractions: one normalized type model feeding the readable catalog, the schema inventory and transitive per-root digests; roots = the logical Session header, the physical JSONL header line, the event envelope, and every repository-declared event; explicit compatibility annotations carrying fingerprinted policy data.
- Data flow: source types → normalized model → catalog + inventory + digests → per-root acknowledgements → accepted checkpoint preservation.
- Non-obvious design decisions: "Source locations, alias names, ordinary comments, and property order are presentation details outside the digest"; historical records retain source file paths without line numbers because their source trees differ from the current checkout; referenced and recursive types participate in structural comparison while opaque values retain explicit coverage limits.
- Edge cases / failure handling: a digest detects a difference but cannot explain whether it adds optional data or changes an existing property — which is why the catalog carries the *normalized* model, not just hashes; regenerating a catalog does not establish that the author reviewed the consequences.
- Surprising: the note was later superseded on one point — "The [reader-compatibility review decision](2026-10-08-session-reader-compatibility-review.md) supersedes the automatic version floor" — and says so in its own text, which is exactly the "keep the note current" discipline the corpus AGENTS.md demands.

### .agents/notes/implemented/process/2026-09-11-persistence-type-history.zh.md
- Chinese twin; its 问题 states that a digest detects change but cannot explain it.

### .agents/notes/implemented/process/2026-09-11-persistence-type-history.i18n.yaml
- Hash sidecar for the persistence-type-history note's heading blocks.

### .agents/notes/implemented/process/2026-09-12-default-product-experimental-isolation.md
- Purpose: keep experimental packages out of the default product by every route, not just the direct one.
- Key abstractions: `verify-default-product-isolation`; `OPTIONAL_BUNDLES` as the one declared exception.
- Data flow: the check follows runtime dependencies, optional dependencies and peers from every app and the Python runtime → resolves workspace and npm aliases → identifies experimental packages by npm prefix or repository directory → then reads runtime imports, profile bundle lists, bundle patches, agent presets and configuration trees, composing the default Web layers with the production patch parser.
- Non-obvious design decisions: "Publication denylist membership has no effect on this classification" — an experimental package is experimental by prefix/directory, not by a flag; effective rows and patched Include trees are checked so "an id-only patch cannot hide a replacement group's plugins"; disabled plugin rows remain checked while ordinary plugin configuration data is not interpreted as another Loader entry list.
- Edge cases / failure handling: the release smoke installs every tarball together, so its consumer directory cannot identify what the default product requires — hence a static graph check; missing default roots fail the check.
- Surprising: the note names the three ways an experimental package could sneak in — dependency aliases, transitive installation paths, and runtime imports declared only for development.

### .agents/notes/implemented/process/2026-09-12-default-product-experimental-isolation.zh.md
- Chinese twin; its 问题 explains why npm publication availability is not default-product membership.

### .agents/notes/implemented/process/2026-09-12-default-product-experimental-isolation.i18n.yaml
- Hash sidecar for the default-product-experimental-isolation note's heading blocks.

### .agents/notes/implemented/process/2026-09-14-generated-cli-help-reference.md
- Purpose: keep the CLI reference from omitting subcommands or keeping obsolete defaults.
- Key abstractions: `PROFILE_TEMPLATES` (shipped profile names); recursive discovery of the `Commands:` section of each captured help page.
- Data flow: run the `dsh` launcher's help, the plugin forwarder's help and each shipped profile's help → parse `Commands:` → recurse → emit a page per command; identical alias help appears once with all invocation forms.
- Non-obvious design decisions: generation uses temporary Harness and Agents homes, and "Help exits before application work starts and requires no server or model."
- Edge cases / failure handling: the plugin forwarder exposes its own help *before* pnpm arguments — "flags after the pnpm command remain pnpm input", so the reference must not attribute pnpm's flags to DSH.
- Surprising: the reference is generated from the same binary the user runs, so the docs can never drift from the flags — and the generation path deliberately avoids starting the app.

### .agents/notes/implemented/process/2026-09-14-generated-cli-help-reference.zh.md
- Chinese twin; its 决策 notes the plugin forwarder shows its own help before pnpm arguments.

### .agents/notes/implemented/process/2026-09-14-generated-cli-help-reference.i18n.yaml
- Hash sidecar for the generated-cli-help-reference note's heading blocks.

### .agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.md
- Purpose: ship an official experimental layer (Agent Teams) with the installation so a user can switch it on without knowing an npm name.
- Key abstractions: `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts`; the plugin manager's `listBundles` reporting `optional`.
- Data flow: the launcher names the bundle → it must be a runtime dependency of `apps/cli` that declares `dsh.bundle.patch` → no shipped profile template selects it → the Web plugin page opens its Official group with the optional bundles, tagged experimental, ahead of the profile's own bundles.
- Non-obvious design decisions: the static isolation gate "skips the `dependencies` edge from `@deepseek-ai/dsh` to a listed bundle and still rejects a runtime import, a shipped composition, a preset, or a default template that names it" — one edge is allowed, everything else is not (line 13).
- Edge cases / failure handling: an optional bundle is "switched off until selected, never removable, resolved from the installation like any installation-supplied bundle"; the workspace-constraints check accepts the same `dependencies` edges and no other runtime section; the packed-install release check skips them from the installed entry package while requiring each listed bundle to be installed.
- Surprising: "optional" is a *distinct* third state in the plugin manager, neither installed-and-removable nor absent — and the default-product-isolation gate had to be amended with an exactly-one-edge exception to make the feature possible.

### .agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.zh.md
- Chinese twin; its 问题 notes that experimental packages were previously only findable on npm.

### .agents/notes/implemented/process/2026-09-15-shipped-optional-bundles.i18n.yaml
- Hash sidecar for the shipped-optional-bundles note's heading blocks.

### .agents/notes/implemented/process/2026-09-17-persistence-schema-review.md
- Purpose: distinguish a declared reader promise from an assumption about runtime behaviour.
- Key abstractions: inventory format 2 with compatibility metadata recorded against the affected property — binding, policy version, literal discriminator, unknown-kind preservation promise and qualified attribution kinds; a separate fingerprint domain for policy-bearing graphs.
- Data flow: source declarations → extractor (explicit source bindings only at the core-owned source declaration; a literal user/developer role at each use) → inventory → reviewer → runtime owners establish and test the promised preservation behaviour before activating a binding.
- Non-obvious design decisions: "Names derived from union positions and traversal paths also change when unrelated siblings are added, obscuring the fields a reviewer needs to inspect" (line 9); graphs without a bound policy keep format-1 normalization and fingerprints, so the new machinery is scoped to the graphs that need it.
- Edge cases / failure handling: existing kinds remain subject to structural comparison; removals, retroactive qualification, reserved identities and unrelated breaking changes retain strict classification; a qualified new attribution kind is permitted only when both saved schemas carry matching promises.
- Surprising: "Inventory versions describe schema tooling, independently of Session format versions" — two version spaces deliberately kept apart, which is the same instinct as the reader-compatibility note.

### .agents/notes/implemented/process/2026-09-17-persistence-schema-review.zh.md
- Chinese twin; its 问题 explains that union-position-derived names change when unrelated siblings are added.

### .agents/notes/implemented/process/2026-09-17-persistence-schema-review.i18n.yaml
- Hash sidecar for the persistence-schema-review note's heading blocks.

### .agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.md
- Purpose: stop Windows packaging from re-signing unchanged Python and LibreOffice files on every build.
- Key abstractions: a cache keyed by original content, public certificate, SignTool bytes, signing-script bytes and cache format.
- Data flow: unsigned native dependency → cache lookup → on a hit, restore through a private staged copy *only after* checking the input record, signed-file digest, Windows trust, timestamp and the configured certificate; publish complete entries atomically.
- Non-obvious design decisions: invalid entries are rejected without automatic repair or hardware fallback; valid vendor signatures are kept; "Different timestamp bytes at the same input/policy key do not require replacement; every actual restoration still verifies Windows trust."
- Edge cases / failure handling: the cache is shared only within the current Windows account and requires a fixed local drive, current-account ownership and a private destination DACL — linked or redirected paths are rejected; concurrent publishers collide and the existing valid entry is retained; explicit migration copies complete integrity-checked entries without modifying the source.
- Surprising: starting PowerShell for each public-key inspection repeated process initialisation, so the cache also removed a per-file process launch — a second, unstated saving.

### .agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.zh.md
- Chinese twin; its 决策 requires a fixed local drive, current-account ownership and a private destination DACL.

### .agents/notes/implemented/process/2026-09-17-windows-runtime-signature-cache.i18n.yaml
- Hash sidecar for the windows-runtime-signature-cache note's heading blocks.

### .agents/notes/implemented/process/2026-09-17-windows-signature-completion.md
- Purpose: stop a timestamp failure from being reported as a signing failure and forcing hardware re-access.
- Key abstractions: a hardware interlock released only after successful signing *and* Windows verification of the primary signature.
- Data flow: sign a private PE copy once without a timestamp → verify → release the interlock → append a timestamp to fresh copies of the frozen signed file without signing credentials.
- Non-obvious design decisions: "Only normal failure or warning exits permit another attempt: at most three calls, with one- and two-second delays" — a launch failure, an uncertain termination, a storage change or a verification failure stops immediately; the preflight's overall 60-second deadline includes these operations.
- Edge cases / failure handling: "Hardware or primary-verification failures retain the interlock; no path automatically recovers it"; appended signatures are unsupported.
- Surprising: the split exists because a combined SignTool command conflates a public, credential-free service (timestamping) with a private-key operation (signing) — a classic "two failure classes, one command" trap that also appears in August's provider-error taxonomy.

### .agents/notes/implemented/process/2026-09-17-windows-signature-completion.zh.md
- Chinese twin; its 问题 explains that a combined SignTool command reports timestamp failure as signing failure.

### .agents/notes/implemented/process/2026-09-17-windows-signature-completion.i18n.yaml
- Hash sidecar for the windows-signature-completion note's heading blocks.

### .agents/notes/implemented/process/2026-09-19-no-unknown-casts.md
- Purpose: stop `as unknown` from silently removing TypeScript's compatibility check.
- Key abstractions: a prohibition on *new* direct assertions to `unknown` — both `as unknown` and `<unknown>`, including parenthesised target types and union targets with a direct `unknown` member.
- Data flow: lint/gate over first-party JS/TS — production code, tests, fixtures, benchmarks and scripts.
- Non-obvious design decisions: existing uses were left in place, because "Removing all of them in one change would combine the enforcement decision with unrelated type and fixture redesigns, making the behavior of each replacement harder to review" (line 9); an `unknown` *declaration* stays valid — `const value: unknown = JSON.parse(text)` — so external data can enter and reach its declared parser.
- Edge cases / failure handling: typed in-process values retain the existing rule against unnecessary runtime validation.
- Surprising: the rule is scoped to *assertions* and explicitly allows declarations — a precise distinction that keeps the ban from becoming "no `unknown` anywhere".

### .agents/notes/implemented/process/2026-09-19-no-unknown-casts.zh.md
- Chinese twin; its 决策 explains why the existing assertions were not removed in the same change.

### .agents/notes/implemented/process/2026-09-19-no-unknown-casts.i18n.yaml
- Hash sidecar for the no-unknown-casts note's heading blocks.

### .agents/notes/implemented/process/2026-09-28-dual-release-install-layout-work-budget.md
- Purpose: make a CI gate measure graph *growth* instead of runner speed.
- Key abstractions: `assertResolutionWorkBudget` bounding `dshPackagesPerVersion * checkedDshEdges` against `MAX_RESOLUTION_WORK_UNITS = 875_000`; `NPM_HANG_GUARD_MS = 4 * MAX_RESOLUTION_WORK_UNITS * SECONDS_PER_WORK_UNIT` (910 s).
- Data flow: `assertDualDshInstallLayout` returns the real counts from the graph npm produced → the budget is applied to those counts → over budget fails with its own counts, the budget and the instruction to measure the new resolution cost and raise the constant.
- Non-obvious design decisions: "That deadline measures the runner, not the graph" — the same graph resolved in 137–205 s on an idle developer host and 288.59 s on the CI runner, 4 % below the deadline, while the placement assertion reported no error (line 9); the wall-clock limit is explicitly "a hang guard, not the growth criterion", derived from the budget so the two values cannot drift apart.
- Edge cases / failure handling: a runner up to four times slower than the measured host cannot decide the gate's outcome — the hang guard is sized for that.
- Surprising: the diagnostic named only elapsed time, "so a slow runner and a graph that had grown were indistinguishable" — the fix is a *unit* the graph can be measured in, not a bigger timeout.

### .agents/notes/implemented/process/2026-09-28-dual-release-install-layout-work-budget.zh.md
- Chinese twin; its 问题 gives the 137–205 s vs 288.59 s measurement.

### .agents/notes/implemented/process/2026-09-28-dual-release-install-layout-work-budget.i18n.yaml
- Hash sidecar for the dual-release-install-layout-budget note's heading blocks.

### .agents/notes/implemented/process/2026-10-05-pr-artifact-typechecks.md
- Purpose: stop every artifact job from rebuilding the repository-wide test and script programs.
- Key abstractions: `pnpm run build:artifacts`; the existing Host and Client aggregates read rather than a maintained package list.
- Data flow: PR artifact build → one serial `tsc -b` compiling every existing project reference from each compiler face → then the ordinary Typert, bundling, Desktop and Web stages.
- Non-obvious design decisions: the build omits "only each root's additional test and script program" while package diagnostics, emitted outputs and Host-before-Client ordering remain required; required Linux consumer and native Windows build jobs keep normal builds including both complete aggregate programs, and release/real-API workflow builds keep their normal checks.
- Edge cases / failure handling: the measurement behind the decision — 304 s of benchmark build preparation before 432 s of serial measurements; a cold macOS arm64 Host compiler profile 84.01 s, of which 55.92 s is the aggregate program and 24.33 s across the 282 emitting projects.
- Surprising: raising concurrency was rejected because it "consumes more shared-runner resources" — the fix was to remove work, not to add parallelism.

### .agents/notes/implemented/process/2026-10-05-pr-artifact-typechecks.zh.md
- Chinese twin; its 问题 gives the baseline timings.

### .agents/notes/implemented/process/2026-10-05-pr-artifact-typechecks.i18n.yaml
- Hash sidecar for the pr-artifact-typechecks note's heading blocks.

### .agents/notes/implemented/process/2026-10-05-product-package-classification.md
- Purpose: stop an installation dependency from sleeping forever.
- Key abstractions: `scripts/product-package-policy.ts` with categories for optional integrations, SDKs, build tools, test tools, Web distribution packages and declaration-only infrastructure; `scripts/verify-product-use.ts`.
- Data flow: the product-use check follows effective shipped profiles, preset children, runtime source imports and explicit dynamic mounts, preserving disabled state through groups and Includes and applying patches before counting use.
- Non-obvious design decisions: "Manifest dependencies and type-only references do not create runtime use"; optional-bundle reachability stays separate from default reachability; "Each exception records its maintained role."
- Edge cases / failure handling: unknown packages and invalid or stale policy entries fail static CI and package hygiene; experimental status "describes maturity and support, independently of installation, optional selection, and Official discovery".
- Surprising: the note makes the *absence* of use illegal — "Nonexperimental packages have effective product use or an explicit entry" (line 13) — which forces every dependency to justify itself.

### .agents/notes/implemented/process/2026-10-05-product-package-classification.zh.md
- Chinese twin; its 问题 notes an SDK can have a product role without appearing in the GUI.

### .agents/notes/implemented/process/2026-10-05-product-package-classification.i18n.yaml
- Hash sidecar for the product-package-classification note's heading blocks.

### .agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md
- Purpose: choose the right criterion for bumping a Session format version.
- Key abstractions: a same-version change test — "older readers either resume correctly, safely ignore optional features while preserving their records, or refuse required features before execution, mutation, or tail repair" (line 13); an upgrade diagnostic for required-feature refusal.
- Data flow: schema change → reader-compatibility review → version decision.
- Non-obvious design decisions: "The user chose reader behavior as the version criterion" — a structural schema difference does not establish that a new integer version is needed; removing a required field or changing its representation is *not automatically* a bump, provided the replacement stays distinguishable and released-reader behaviour still satisfies the admission requirements.
- Edge cases / failure handling: "Feature absence must preserve existing behavior"; already released binaries retain their existing diagnostics, so review identifies any limitation explicitly; new readers accept valid mixtures of old and new representations within one Session; reusing a logged value with a different meaning, or missing admission checks, are both bump triggers.
- Surprising: the worked example is an *optional* environment header field — sessions that omit it keep identical logs, while sessions that require it are refused by older readers — and a global bump would exclude the feature-free sessions and force a new generation plus an adjacent migration.

### .agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.zh.md
- Chinese twin; its 问题 gives the optional environment header field as the worked example.

### .agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.i18n.yaml
- Hash sidecar for the session-reader-compatibility-review note's heading blocks.

### .agents/notes/implemented/process/2026-10-11-build-artifacts-check-split.md
- Purpose: take the two `noEmit` root type-check programs off the serial build path.
- Key abstractions: `build:artifacts` and `build:check`, with `build` running both concurrently.
- Data flow: `pnpm run build` → native addon → package-library build (Host `tsc -b` → Host tsdown → Desktop bundle → Client `tsc -b` → Client tsdown) → Web build; the two root programs (Host 68.5 s, Client 36.0 s) move into the concurrent check phase.
- Non-obvious design decisions: those root programs "emit no files and feed no later artifact step, yet sit on the serial critical path"; the only way to skip them was the CI-oriented `pnpm run build --artifacts-only`, which has no local development name and no counterpart that runs only those two checks.
- Edge cases / failure handling: `pnpm run build` must stay complete and detect every type error — the split adds a command, it does not weaken the default.
- Surprising: the motivating numbers are small relative to the 249 s serial package-library build, yet the note still treats them as worth removing — because the *ratio* of fixed cost to variable cost is what makes a cold build slow on small edits.

### .agents/notes/implemented/process/2026-10-11-build-artifacts-check-split.zh.md
- Chinese twin; its 问题 quantifies the three fixed costs (249 s serial package-library build).

### .agents/notes/implemented/process/2026-10-11-build-artifacts-check-split.i18n.yaml
- Hash sidecar for the build-artifacts-check-split note's heading blocks.

### .agents/notes/implemented/process/2026-10-11-lossless-build-speedups.md
- Purpose: remove three fixed cold-build costs without changing output bytes.
- Key abstractions: three independent fixes — the `@types/react` symlink fan-out, Typert's synchronous discovery inside the first tsdown `writeBundle`, and per-config `globSync('packages/*/*/package.json')` manifest lookups.
- Data flow: measured counters (88 JSX files × 2 modules × 65 locations → 11 457 `tryGetModuleNameFromPaths` calls and 5 623 782 entry scans, 32.6 s; Typert blocking the tsdown main thread 12.4 s, discovery 8.06 s across 362 package tsconfigs and 322 registrations; `workspaceManifest` 3.95 s of an 11.7 s Client pass) → each fix targets one of them.
- Non-obvious design decisions: the note fits a **dose-response curve** — truncating the visible location count N from 65 down to 1 gives Check 58.40 s → 26.92 s, fitting Check ≈ 26.9 + 0.494·N s (line 11) — so the fix is aimed at the variable that actually explains the cost.
- Edge cases / failure handling: the module-level manifest cache "has no effect because tsdown's native config loader imports every package config through `import-without-cache`, creating a fresh module instance per config" — a cache that cannot work is named as such rather than blamed on the consumer.
- Surprising: 66 manifests declare `@types/react`, so pnpm creates one `node_modules/@types/react` link per workspace package and the Client test aggregate sees 65 locations — a cost created by the *package manager's* layout, not by the code.

### .agents/notes/implemented/process/2026-10-11-lossless-build-speedups.zh.md
- Chinese twin; its 问题 gives the fitted model Check ≈ 26.9 + 0.494·N s.

### .agents/notes/implemented/process/2026-10-11-lossless-build-speedups.i18n.yaml
- Hash sidecar for the lossless-build-speedups note's heading blocks.

### .agents/notes/implemented/process/2026-10-12-local-gate-speedups.md
- Purpose: make the local feedback loop stop doing work whose results it does not depend on.
- Key abstractions: the pre-push `typecheck` prerequisite `build:lib:host`; the pre-commit notices job; the Vitest fork count; the Git prefix lookup; repeated Markdown parsing.
- Data flow: measurement → each cost attacked at its source: Typert declarations split away from type checking, notices regenerated only when a generator input is staged, `os.availableParallelism()` corrected to the *container's* CPU quota, one prefix lookup per candidate, and caching of Markdown parses and directory reads.
- Non-obvious design decisions: "Host CPUs as the local worker count" — `os.availableParallelism()` reported 256 (the host's CPUs) rather than the container's 64-CPU quota, so `pnpm run test` started 255 Vitest forks, peaked at 55.3 GiB RSS and failed 12 additional files (14 timeouts) intermittently (line 9 region).
- Edge cases / failure handling: the note quantifies each cost before changing it (typecheck 34.1/35.0 s with nothing to recheck; the prerequisite 52.2/29.6 s; notices 12.4/13.4 s of a 16.5/17.8 s hook; 26 000 prefix lookups costing 135.7 s of a 166.8 s gate; 1 835 documents parsed for type equivalence).
- Surprising: the biggest local win is not an optimisation but a *correct count* — the worker count was wrong by 4× because a host-level API was used where the container quota was meant.

### .agents/notes/implemented/process/2026-10-12-local-gate-speedups.zh.md
- Chinese twin; its 问题 lists the six measured costs with their timings.

### .agents/notes/implemented/process/2026-10-12-local-gate-speedups.i18n.yaml
- Hash sidecar for the local-gate-speedups note's heading blocks.

### .agents/notes/implemented/process/2026-10-14-experimental-dependency-policy.md
- Purpose: stop experimental packages from being exempt from the dependency-declaration rules.
- Key abstractions: the check scope widens to `packages/*/*/package.json`; `readHostBuildEntries` importing each package's `tsdown.config.ts` under the `host` and `client` build faces (`DSH_BUILD_FACE`).
- Data flow: package manifests → dependency-section rules; build entries → the set of worker/child-process entries whose platform is not browser and whose source is outside `src/client/` → runtime-import tracing.
- Non-obvious design decisions: the verifier does not guess from source patterns — "The configurations can only be imported asynchronously, so the verifier's state reading is async"; the scope previously read `packages/!(experimental)/*/package.json`, exempting the whole group.
- Edge cases / failure handling: the exemption had produced 4 experimental client packages declaring client/api/session packages as `peerDependencies`; because the webworker packer follows workspace peers into the image, browser static libraries became sweep roots and packing agent-team-profile produced 82 unresolvable requests; checking the 6 experimental packages declaring `dsh.client` found 46 violations, all in experimental packages.
- Surprising: the verifier that traced runtime imports only from the Host entry misclassified inspector's `ws` as devDependencies-only, because it is used solely in a `worker_threads` entry — the same "declaration site ≠ use site" trap that appears in the subagent tool-filter note.

### .agents/notes/implemented/process/2026-10-14-experimental-dependency-policy.zh.md
- Chinese twin; its 问题 records the 4 peerDependency offenders and the 82 unresolvable requests.

### .agents/notes/implemented/process/2026-10-14-experimental-dependency-policy.i18n.yaml
- Hash sidecar for the experimental-dependency-policy note's heading blocks.

### .agents/notes/implemented/process/2026-10-14-no-top-level-await-in-packages.md
- Purpose: forbid top-level await in package sources.
- Key abstractions: entry modules use an explicit `async function main()`.
- Data flow: three sites converted — sensevoice's `src/worker.ts` (writes only the error to stderr and exits 1 once flushed, because a loaded native recognizer would otherwise keep the process alive; stdout carries one `{"port":N}` line the Host parses as readiness), ssh's `src/helper-entry.ts` (try/catch/finally and signal handling inside `main()`, errors prefixed `dsh-ssh-sandbox:` and exit 127), and inspector's `src/worker/entry.ts` (synchronous startup stays at module scope, the async part runs in `main()`, and a failure sends the failure frame before stopping).
- Non-obvious design decisions: top-level await makes module evaluation asynchronous, so an importer's evaluation waits on it and an entry failure becomes a *module-loading* failure instead of an error the entry handles explicitly; the same file is the package's `./worker` export and the browser Preview's module loader wraps module bodies as CommonJS, "which refuses to pack top-level await, so it kept voice-input-bundle out of the image".
- Edge cases / failure handling: no repository gate prevented the pattern, so the fix started with a repository-wide scan that found two more cases outside `bin` — the fix included *finding* the offenders, not just one.
- Surprising: a packaging failure (a bundle that cannot be built) and a runtime failure (an error the entry cannot handle) share one language-level cause; the note treats the constraint as a property of module semantics rather than a style rule.

### .agents/notes/implemented/process/2026-10-14-no-top-level-await-in-packages.zh.md
- Chinese twin; its 问题 names the three sites found by the repository-wide scan.

### .agents/notes/implemented/process/2026-10-14-no-top-level-await-in-packages.i18n.yaml
- Hash sidecar for the no-top-level-await note's heading blocks.

---

## Ideas worth stealing

- **Append the changed system prompt instead of rewriting message 0, when the route declares the capability** — `.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md:11` and `:17` — DSH records the exact model fact ("a DeepSeek model accepts a `system` message at any position of the conversation and treats the latest one as the complete effective system prompt, replacing the leading one") and then makes the *route* declare `systemPromptUpdate: 'in-history'`, so a prompt change appends a new `system/message` node instead of rewriting node 0 and the provider prefix cache survives. August currently re-renders its system prompt every step and any byte change busts the DeepSeek cache from token 1; this is a one-capability, one-routing-rule change with a documented fallback for incapable routes, and the note even specifies the accounting side (`dsh-token-meter` prices the last surviving system node as `systemTokens`).

- **Treat the system prompt as an append-only surface, and move every volatile fact out of it** — `.agents/notes/implemented/feature/2026-09-02-in-history-system-prompt-replacement.md:36` (`startsSeries` rules) and `.agents/notes/implemented/bug-fix/2026-10-11-process-specific-prompt-values-in-runtime-context.md:9` — the second note gives the *hard* failure that makes this non-negotiable: Claude binds historical thinking-block signatures to the conversation prefix *including the system prompt*, so a changed prompt returns `400 Invalid signature … bound to a different conversation` and the Session cannot continue. August already freezes its memory index per session for cache stability; this generalises the rule to every volatile value (ports, paths, URLs) and supplies the exact symptom to design against.

- **A per-tool, unary, fail-closed concurrency classifier, evaluated at dispatch time** — `.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md:17`, `:29`, `:45` — each tool may expose `isConcurrencySafe(args)`, a synchronous pure function; only an explicit `true` opts in, anything else (missing, throwing, wrong type) is exclusive. Consecutive parallel calls form a group, an exclusive call is a barrier, and only *dispatch + body* overlap while `pre-execute`/`post-execute` stay in model order because middleware may hold ordered state. August's parallel tool execution needs exactly this and cannot ship a resource-aware contract, so the unary form is the realistic ceiling.

- **One resolver for tool visibility AND tool execution — and the explicit statement that visibility is not authority** — `.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md:39` and `:76` — the same live registry predicate drives wire schemas, lookup, execution and PTC SDK generation, so a model cannot execute a tool the prompt says does not exist; and the note refuses to call that a security boundary ("they do not authorize it … no parent-to-child grant lattice, no requirement that a child be a subset of its parent"). This is the conceptual frame August's deny-set / `currentSubagentDenied` design needs, and it is the sentence that keeps a visibility filter from being mistaken for confinement.

- **Canonical tool results separated from their rendered prose, with typed handles and an explicit over-limit failure** — `.agents/notes/implemented/feature/2026-07-20-ptc-typed-tool-returns.md:54`, `:62`, `:70` — bindings resolve to the tool's canonical `JsonValue`, failures reject with a real `ToolCallError` (not a string), background jobs return `{ kind: 'background', jobId }` instead of prose, and an over-cap completion fails as `output-limit` rather than being silently truncated. August's `job_output` / background-job path currently makes the model parse ids out of English sentences; this is the same idea at the message level and it composes with the fact that August already has a `ToolCallError`-shaped need in its PTC/code-mode path.

- **One inbox, one ordering authority, and an explicit durability statement** — `.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.md:90` and `:140` — "The Agent inbox is the only queue" (agent messages Steer, human prompts Queue-or-Steer), and "Only messages written to the child Session log are reconstructable with the source that supplied them; inbox acceptance alone provides no restart guarantee". August's Bot-to-Bot DM path is exactly the place a second FIFO would appear, and this note gives both the fix (one queue) and the honest limit (accepted-but-unlogged work is lost and is *not* replayed).

- **Compare-and-set on shared task state plus a blocking wait edge instead of model polling** — `.agents/notes/implemented/feature/2026-08-05-agent-teams.md:47` and `:49` — every task mutation carries `expectedRevision`, only the Lead assigns, and `wait_agent` blocks on one roster/mailbox/task/status edge registered *after* the call starts, so callers never poll. August's Bot rooms currently bound work with `rooms.MAX_ROUNDS` plus a stall detector; this replaces polling with a primitive, and the note's refusal to treat ownership or `writeScopes` as locks ("False mutual exclusion is more dangerous than an explicit warning") is the right posture for a shared checkout.

- **Producer-declared context *shape*, separate from producer identity, with opaque as the documented default** — `.agents/notes/implemented/feature/2026-08-05-context-form-vocabulary.md:17` and `:44` — `MessageSource` gains a small tagged `form` vocabulary (instructions / catalog / snapshot / notice / relay / recall) that says *what kind of thing was added*, and anything unknown, absent or unreadable renders as the opaque body. August renders every injected context row as one blob; adding a `form` field to the durable message source is a small change with a large rendering payoff, and the "opaque is the default, so old logs still render" rule is what makes it safe to ship.

- **Separate a policy DENIAL from a technical FAILURE, and let a human arbitrate the denial** — `.agents/notes/implemented/feature/2026-09-24-auto-review-user-approval-fallback.md:13` and `:17` — a reviewer denial is routed into the existing `ask` decision so a human can `allowed-once` it, while a reviewer *failure* produces a different message carrying the finish kind, failure code and provider message. August's self-heal already learned this lesson the hard way (a refusal text that read as success); this note is the generalised form, and the reasoning for *not* asking after a failure ("a failure says nothing about the action's risk") is directly transferable.

- **Execution-time authority for model-facing state-changing tools** — `.agents/notes/implemented/feature/2026-07-19-model-facing-goal-tools.md:29` and `:31` — every call requires an `exec.agent` that is the exact live registry object, the current driver initiator, with an open turn; and "User source is a host attestation" (every `followup()`/`steer()` input must carry an explicit source). August's `_authority_refusal` and `agentId`-vs-`agentId` derivation bugs are the same class; the two ideas worth taking verbatim are the *host attestation* of message source and the durable-paused escape hatch (the model cannot resume a paused goal — the user-facing path owns that transition).

- **Refuse-by-default when the hidden work is still running, then stop after the write** — `.agents/notes/implemented/feature/2026-09-21-archive-stops-running-session-work.md:15` and `:16` — `archiveSession` rejects when `workspace/session-activity` reports anything running; with `stopActivity: true` the archive is written *first* and the stop dispatched afterwards, so every wake the stop induces is already blocked; and an `agent/pre-step` gate rejects any model step proposed for an archived Session or its descendants. August's Bot/background path can hide work the same way, and the ordering (write the durable state, then stop) plus the pre-step gate is a two-part fix that needs no new event type.

- **Kernel arbitration for cross-process write ownership instead of a TTL record** — `.agents/notes/implemented/feature/2026-08-31-cross-process-session-write-lease.md:13` — `flock(2)` on POSIX and a named kernel semaphore on Windows, with the POSIX inode re-verification ("a POSIX lock names an inode rather than a path"), and no expiry bookkeeping because the kernel releases on process death. The alternatives section records why the TTL+rename design was replaced and why Windows byte-range locks (`LockFileEx`) and `CreateFileW` share-mode denial were both rejected *with CI evidence*. If August ever runs two writers over one session log, this is the shape to copy.

- **Make a gate measure the thing it claims to measure** — `.agents/notes/implemented/process/2026-09-28-dual-release-install-layout-work-budget.md:13` and `.agents/notes/implemented/process/2026-10-11-lossless-build-speedups.md:11` — the first replaces a wall-clock timeout with a *growth unit* (`dshPackagesPerVersion * checkedDshEdges` against `MAX_RESOLUTION_WORK_UNITS = 875_000`) because "that deadline measures the runner, not the graph"; the second fits a dose-response curve (Check ≈ 26.9 + 0.494·N s) so the fix targets the variable that explains the cost. August's `check:*` gates are mostly static form checks; a gate expressed in *units of the thing that grows* is the version that catches drift before a timeout does.

- **Version a persisted format by READER compatibility, not by schema difference** — `.agents/notes/implemented/process/2026-10-08-session-reader-compatibility-review.md:13` — a same-version change is permitted when older readers either resume correctly, safely ignore optional features while preserving their records, or refuse required features *before* execution, mutation or tail repair; feature absence must preserve existing behaviour; removing a required field is not automatically a bump if the replacement stays distinguishable. August's session format and migrations would benefit from this exact test, because it separates "the bytes differ" from "an old reader is now unsafe".

- **Give the note corpus a principled retention boundary** — `.agents/notes/implemented/process/2026-07-26-frozen-agent-note-archive.md:13` — small UI adjustments and mechanical changes are **deleted** as complete triplets (with inbound links repaired), only shipped-complete + low-future-value + historically valuable notes are archived, and "Foundational boundaries, durable and wire semantics, security rules, recurring design temptations, and unresolved reintroduction conditions remain active regardless of age or word count". August's AGENTS.md is 68 KB and its own rules forbid minting a new Part number; this gives a principled way to keep the corpus small without losing the reasoning that stops a tempting mistake.

- **A deny-list for a whole vocabulary, applied to code and filenames as well as prose** — `.agents/notes/implemented/process/2026-08-26-ban-ambiguous-origin-label.md:13` — one ambiguous token had accumulated eight unrelated meanings and the prose policy could not remove it because "it allowed the same ambiguous label to remain in APIs, durable compatibility fixtures, filenames, generated catalogs, and new prose". August has exactly this hazard in terms like "source", "origin", "evidence" and "provenance" across the brain, transcript and audit surfaces; the transferable move is to ban the *token* everywhere and force each site to name its exact local concept.

- **Assert capability, don't infer it** — `.agents/notes/implemented/feature/2026-09-07-deepseek-messages-adapter.md:15` and `:23` — DeepSeek effort is `output_config.effort`, not an Anthropic thinking budget, and the Messages system-update behaviour is declared per endpoint/model because "capability inference from protocol or model names is insufficient". August's per-model capability profiles (`toolSurface`, `maxTools`, `maxToolResultChars`) already work this way; the transferable part is the *refusal to infer* — and the same note records that a JSON syntax failure after a 200 is `INVALID_RESPONSE`, not `TRANSPORT`, and earns no retry, which is a precise error-taxonomy rule August could adopt verbatim.

---

## Files skipped (with reasons)

- **None.** Every one of the 257 files in this shard was opened and read; no file was skipped, and none is generated, vendored, binary or huge-data (the largest file in the shard is `feature/2026-09-17-sidebar-file-and-directory-auto-refresh.md` at 36 839 bytes; the largest is an English prose note, not a data blob). There is no `manifest.json` or other generated artefact in this shard — the generated `manifest.json` in the manifest belongs to `.agents/notes/archived/`, which is another shard's file.

  Read depth, stated honestly per file class (this is the one place where "read" has a gradation, and it is what the ledger's `read` status means):
  - **85 English `.md` notes** — read **in full** for the 11 lens-critical feature notes (PTC, typed tool returns, parallel tool call execution, subagent persona/tool-filter/depth, continuable subagents, agent teams, context-form vocabulary, in-history system prompt replacement, model-facing goal tools, DeepSeek Messages adapter, config-schema dump policy) and for `feature/2026-07-28-continuable-subagent-conversations.md`; read as the **first 14–34 lines** (title, status, Problem, and the opening of Decision) for the remaining 74 English notes, with section headings and the head of each major section visible.
  - **85 Chinese `.zh.md` twins** — read as the **first 8–11 lines** of each (title, status, language switch, and the opening of the 问题/Problem section), which is enough to establish that each is the section-aligned Chinese translation of its English counterpart and to capture the note's subject; the remainder of each Chinese file was **not** read line by line.
  - **85 `.i18n.yaml` sidecars** — read as the **first 8 lines** of each (the header comment plus the root anchor and its EN/ZH hashes); the per-section anchor list beyond the first one was not read for every file, though the anchor naming convention (`/problem`, `/decision`, `/alternatives-considered`, `/consequences`, `/verification`) was confirmed on the file read in full.

---

## Uncertainties

- **I did not read every line of the 74 non-lens-critical English notes, nor the bodies of the 85 Chinese twins.** For those, my per-file notes are grounded in the title, the Problem section and the opening of the Decision section (plus the i18n.yaml anchor names, which reveal the section inventory). Where a note's most interesting mechanism lives in a later section (usually "Alternatives considered" or "Consequences"), my one-line ledger note may under-report it. I have not guessed beyond what I read; where I could only see the head, the note says what the head says.
- **The `.zh.md` files are section-aligned translations, not literal sentence translations.** Several use a different heading vocabulary (`问题` / `决策` / `曾考虑的替代方案` / `后果` / `验证`) while others keep the English headings (`Problem` / `Decision`) with Chinese bodies. I confirmed the section *inventory* matches the English twin for the files I read in full, but I did not verify paragraph-by-paragraph correspondence for all 85.
- **I did not verify the referenced code.** Every mechanism in these notes is described by the note itself; I did not open `packages/core/agent-loop`, `packages/core/tools`, `packages/session/session-persistence-jsonl/src/lease.ts`, `packages/llm/llm-deepseek`, `packages/experimental/agent-team` or any other source file, because those belong to other shards. So a note's claim about a symbol's behaviour is *the note's claim*, verified only against itself. In particular I could not check whether `isConcurrencySafe` is really unary in the code, whether the Windows lease really uses a named semaphore, or whether the `deepseek-flash` catalog entry really declares `systemPromptUpdate: 'in-history'` — only that the notes assert these.
- **I could not measure how current the corpus is.** Notes reference dates from 2026-06 to 2026-10 and cross-reference each other and *archived* notes (outside this shard). Several notes state that they supersede or are superseded by others (e.g. `2026-09-11-persistence-type-history.md` says the reader-compatibility decision supersedes its version floor); I recorded those statements as the notes make them, without checking the other side.
- **The shard boundary is manifest-driven, not directory-driven.** My shard is exactly manifest lines 2780–3036 (257 rows, all `.agents/notes/implemented/**`). I did not read the sibling `architecture/`, `simplification/` and `testing/` notes that exist in the same directory — my bulk head-dump of `*.zh.md` incidentally opened their heads, which confirmed the corpus-wide section conventions but is not a read of those files, and they are not in my ledger.
