# deepseek-harness / dsh-notes-arch#1

## Shard shape

This shard is the whole `architecture` tier of the repo's archived agent notes: 87 decisions, each shipped as a triplet of `X.md` (English), `X.zh.md` (Chinese translation) and `X.i18n.yaml` (a bilingual-pair blob-hash consistency record) — 260 files, ~1.6 MB. The subject matter is the harness's *seams*: what the agent loop is, how a turn is bounded and cancelled, how the session log is persisted and replayed, how the filesystem, shell, LSP, jobs and subprocess capabilities are split into interface / provider / consumer, how prompt assembly and tool schemas are composed, and how the GUI/TUI/web surfaces are layered over the same event stream. Almost every note is a "Problem → Decision → Alternatives → Consequences" record written *after* the fact, so they are unusually good evidence of why the code has the shape it does. The set is dated 2026-06-11 through 2026-08-06 and reads as a running architectural log of the `dsh-*` TypeScript monorepo (Cordis plugin framework, `@deepseek-ai/dsh-*` packages, an ACP bridge, a TUI and a web client).

## Per-file notes

### .agents/notes/archived/architecture/2026-06-11-content-block-vocabulary.md
- Purpose: Establishes the provider-neutral internal message language (typed content blocks) that the loop, session log and plugins all speak.
- Key abstractions: `ContentBlockMap` (merge-extensible map → derived union of `text` / `reasoning` / `tool-call` blocks); `MessageSource`, `FinishReason`, `TurnTrigger`, `TurnEndReason` typed by the same merge-extensible-map trick; `BlockAssembler` as the single shared streaming assembler.
- Data flow: adapters translate canonical blocks to provider wire formats; `BlockAssembler` is the only place raw stream chunks become blocks.
- Non-obvious design decisions: in-session context injection and mid-turn steering deliberately project as *plain user content* rather than a new role, so adapters carry zero burden for it; the note explicitly says a future provider mismatch "belongs in that adapter rather than a new canonical role".
- Edge cases / failure handling: released Session format v3 still carries the historical `tool-result` block inside a user-role wrapper, and the adjacent V3→V4 edge lifts it into a first-class role.
- Surprising: tool results are first-class tool-role messages whose own content holds result blocks — the log shape differs from what a chat-completions mirror would suggest.

### .agents/notes/archived/architecture/2026-06-11-custom-schema-dsl.md
- Purpose: The tool-author DSL that gives typed `execute(args)` while still emitting standard JSON Schema on the wire.
- Key abstractions: `ParameterSchemaSpec` with per-property `required: true` (not JSON Schema's `required` array); `InferArgs<S>`; `parameterSchemaSpecToJsonSchema()`; `defineTool()`.
- Data flow: `defineTool` ties inference, JSON-Schema compilation and validation together; raw JSON-Schema `ToolDefinition`s are still accepted by `ToolRegistry.register()` for MCP/external tools.
- Non-obvious design decisions: schemastery (already vendored) was rejected because it validates against StandardSchema rather than *generating* JSON Schema; the note marks this decision as superseded by the unified JSON-value schema DSL.
- Edge cases / failure handling: the early optionality bug in the `InferArgs` mapping is regression-tested at the type level.
- Surprising: the "custom DSL" is deliberately small — a superseding note owns the real vocabulary.

### .agents/notes/archived/architecture/2026-06-11-microkernel-event-taxonomy.md
- Purpose: The extension contract — "everything is a plugin" — expressed as a Cordis event taxonomy with four dispatch modes.
- Key abstractions: waterfall (around-middleware: `agent/pre-step`, `agent/request`, `agent/request-error`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`, `llm/stream`, `system-prompt/assemble`), serial (`agent/turn-stopping`), parallel (`session/flush`), emit (notifications, `tools/result`).
- Data flow: contract packages declare event vocabularies (`dsh-agent` declares `agent/*`); `@deepseek-ai/dsh-agent-loop` is the only concrete loop plugin and is itself swappable.
- Non-obvious design decisions: the loop's extension points are *typed events* rather than a purpose-built middleware stack or phase state machine, because Cordis effects give HMR and disposal for free.
- Edge cases / failure handling: the loop must be defensive — plugin exceptions are contained at turn level and steering from any extension point is never stranded (regression-tested).
- Surprising: the note calls waterfall semantics "non-obvious and must be taught".

### .agents/notes/archived/architecture/2026-06-11-runtime-arg-validation.md
- Purpose: Closes the gap between a compile-time `InferArgs` claim and the runtime JSON the model actually sends.
- Key abstractions: `validateArgs(spec, args): string[]`; `validateJsonSchemaValue()` (shared walker); `ToolArgsError` with code `INVALID_ARGS`.
- Data flow: `defineTool` snapshots the compiled parameter schema at definition time and validates before the typed body runs; the registry returns violations as an error result the model can correct.
- Non-obvious design decisions: validator and compiler must share *exact* semantics — implicit parameter root is an open object, required keys come only from `required: true`, defaults are annotations, `oneOf` accepts exactly one matching branch.
- Edge cases / failure handling: raw-registered tools own their input validation; a property test generates spec-satisfying args and asserts they pass, with targeted corruptions rejected — that is how validator/`InferArgs` drift is closed mechanically.
- Surprising: the "tool gets actionable feedback on its own malformed calls" is the whole point — an opaque crash was the old failure mode.

### .agents/notes/archived/architecture/2026-06-11-structured-error-taxonomy.md
- Purpose: Makes failures machine-routable across seams instead of bare strings.
- Key abstractions: `HarnessError extends Error` in `dsh-llm` (stable `code` distinct from `message`, `cause` chaining via `ErrorOptions`); `isHarnessError`; `ToolExecutionResult.error?: { name, code }`.
- Data flow: the registry's catch populates `error` for a `HarnessError`; the agent loop forwards it onto the `tool/result` session event, so structured failure survives into the log for retry/sandbox plugins and replay.
- Non-obvious design decisions: the base class lives in the *leaf* package every other already imports, so it costs one import and no new dependency edge; the model-facing text block is deliberately unchanged.
- Edge cases / failure handling: a non-Error throw is wrapped as `HarnessError` with `code: 'UNKNOWN'` and the original chained as `cause`, so even a bad throw carries a routable code.
- Surprising: `deriveMessages` does *not* surface `error` into model history — the structured field is for code and replay only.

### .agents/notes/archived/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md
- Purpose: Decides that "what the model is told it can do" is one concern: prompt text *and* tool schemas.
- Key abstractions: `PromptAssembly { sections, tools }`; the `system-prompt/assemble` waterfall.
- Data flow: the system-prompt service collects ordered sections and tool schemas (the registry auto-contributes); the loop consumes one assembly per step; adapters map sections→system slot, tools→wire `tools` field.
- Non-obvious design decisions: tool filtering (ToolSearch / progressive disclosure) is an *assembly rewrite*, same as prompt edits — one interception point instead of two listeners on two surfaces.
- Edge cases / failure handling: the assembly interface is merge-extensible for future slots; there is no untyped `extras` bag.
- Surprising: schemas in a "prompt" service is called out as a conceptual surprise and documented in the package README.

### .agents/notes/archived/architecture/2026-06-14-session-persistence.md
- Purpose: Turns the in-memory session into a durable, resumable, forkable log.
- Key abstractions: abstract `SessionPersistence` service (`create`/`open`/`stat`/`list`/`flush`) with per-session `SessionHandle`s; `SessionHeader` (out-of-log metadata: version, cwd, lineage); the persisted unit IS the existing `SessionEvent` `{ type, seq, time, data }` — no parallel type.
- Data flow: `ctx.agents.resume({ resumeSessionId })` opens the write handle, reads the stored log and publishes the prepared Session under the persisted id; `deriveMessages()` projects the log into LLM history.
- Non-obvious design decisions: append-only — a crashed turn is *closed, never truncated*; the reader owns balancing and appends synthetic `turn/end {kind:'interrupted'}` closers. Metadata is deliberately *out* of the log (an in-log `session/meta` event was rejected because metadata is not replayable state). The file backend is canonical while the service stays extensible.
- Edge cases / failure handling: only the incomplete fragment of a torn final append is discarded; a parse error or sequence gap in the committed prefix is corruption and makes the session unloadable. `createdAt` must be a non-negative safe-integer Unix-ms; fractional values are rejected at creation and in JSONL.
- Surprising: `session_id` and `seq = log.length` coupling means removing an event requires a *dense renumbering* migration, so the log is explicitly append-only.

### .agents/notes/archived/architecture/2026-06-15-turn-enclosure-invariant.md
- Purpose: Makes the turn the single durability/replay boundary — no session event may live outside a turn.
- Key abstractions: `turn/start` / `turn/end`; a new `injection` variant in the merge-extensible `TurnTriggerMap`; `ctx.invariants` registration of the check.
- Data flow: queued `user/message` events are appended *after* `turn/start`; an `agent.inject()` made while running joins the open turn, and one made while idle wraps its `context/message` in a one-shot `turn/start{trigger:{kind:'injection'}}` → `context/message` → `turn/end{completed}`.
- Non-obvious design decisions: the turn number is derived from the log each iteration (`lastTurnNumber(session) + 1`) instead of a private counter, so an idle injection's one-shot turn cannot collide with the next real turn's number.
- Edge cases / failure handling: a flush failure has no valid in-turn position, so it is reported through `agent/error` and logging rather than appended as a session event — this keeps the replay log balanced.
- Surprising: the bug was that an idle background-task notice was durably on disk but *silently dropped on resume* by `scanLog`.

### .agents/notes/archived/architecture/2026-06-17-filesystem-capability-seam.md
- Purpose: The three-package filesystem seam (`dsh-fs` interface / `dsh-fs-local` provider / `dsh-tool-fs` consumer) and the model-facing read/write/edit tools.
- Key abstractions: `ctx.fs` semantic service (resolve, stat, readText/streamText, writeText, editText); opaque `targetKey` vs `displayPath` vs original input path; opaque `version` token minted by the backend; `FsError extends HarnessError` with codes `FS_NOT_FOUND`, `FS_NOT_TEXT`, `FS_STALE_VERSION`, `FS_NOT_OBSERVED`, `FS_NOT_REGULAR_FILE`, `FS_AMBIGUOUS_EDIT`, `FS_EDIT_NOT_FOUND`, `FS_ABORTED`.
- Data flow: the tool validates model args → calls `ctx.fs` → formats `ContentBlock[]`; `ToolRuntime.execute()` converts thrown errors into `isError` results.
- Non-obvious design decisions: literal `editText` is a *provider primitive*, not read+write composed in the tool, so literal matching, duplicate-match rejection, CRLF preservation and the atomic read-modify-write stay inside one critical section. Observed-state is *not* on `ctx.fs` (a sandboxed backend must not inherit model-facing policy). Authorization is version freshness, not a full/partial view distinction — a windowed read of lines 100-150 authorizes an edit of line 120.
- Edge cases / failure handling: atomic write stages through a private random `0700` directory with an exclusive `0o600` temp file and a final rename, because predictable temp paths invite symlink races; two concurrent writes settle deterministically (one wins, the other `FS_STALE_VERSION`).
- Surprising: `cwd` is a resolution default, *not* a sandbox — containment must be enforced by a backend or by a permission plugin on `tools/execute`.

### .agents/notes/archived/architecture/2026-06-18-agent-lifecycle-and-ownership-contracts.md
- Purpose: Three ownership contracts: queue-aware cancel, an `AgentHandle` disposer, and a bash owner token.
- Key abstractions: `Agent.cancel(cause?)` as the single public stop primitive; `AgentHandle = { agent, dispose(): Promise<void> }`; `ShellExecutor.ownerOf(id)`; `AgentCancelCause` typed by the loop.
- Data flow: `ctx.agents.create`/`resume` return a handle; the disposer stops the loop, awaits exit and idle flushes (true quiescence), detaches agent, detaches session, unwinds scope.
- Non-obvious design decisions: teardown **order** is load-bearing — the agent's session lifecycle is folded into a SINGLE composite Cordis effect because a fiber unload disposes sibling effects concurrently (`Promise.all`), which would race the store's append hooks against the loop's closing `session/flush` and drop the closing `turn/end`. The bash owner token moved from a plugin-local `Map` into the executor so ownership survives a `tool-bash` HMR reload.
- Edge cases / failure handling: a create that loses the close race disposes its unpublished handle; ACP holds each fresh session's disposer in its `SessionRecord` so a bare client disconnect leaves no registered agent.
- Surprising: the access *policy* (token comparison) stays in the consumer while the bash capability keeps `owner` opaque — the Service Definition / Provider / Consumer split applied to a security check.

### .agents/notes/archived/architecture/2026-06-18-shared-persistence-write-coordinator.md
- Purpose: A backend-agnostic `PersistenceCoordinator` so every persistence provider does not re-implement write orchestration.
- Key abstractions: `PersistenceCoordinator` (concrete class, composed not inherited); `PersistenceBackend<TornMarker>` hook interface (`name`, `loadStored`, `appendBatch`, `materializeHeader?`, `commitRepair`, `list`, `close?`); the **opaque torn marker**.
- Data flow: the coordinator holds one lifecycle entry per live `Session` with a write controller (pending events, fixed batching deadline, active write, failure retention, shared flush barrier); each `session/event` enters that bounded path, `session/flush` bypasses the wait.
- Non-obvious design decisions: composition, not inheritance, so a backend "cannot reach the coordinator's private orchestration state"; the torn marker is opaque so the coordinator knows neither byte lengths nor frame recovery state. `commitRepair` is explicitly *not* required to be atomic.
- Edge cases / failure handling: a failed retirement leaves the controller discoverable for backend teardown to retry; settled per-id chain tails remove themselves only when still current, so a completion cannot erase a newer operation for the same id.
- Surprising: creation *borrows* the exact `Session.events` snapshot as its persistence seed instead of cloning the whole log again.

### .agents/notes/archived/architecture/2026-06-20-branded-ids.md
- Purpose: Extends nominal typing to the ids that actually cross package boundaries and could plausibly be confused.
- Key abstractions: `Branded<B> = string & { readonly [BRAND]: B }` and the stateless `brandString<T>()`; new `BashTaskId` and `OwnerToken` brands.
- Data flow: `brandString<T>()` returns its input unchanged, so serialization, comparison and wire formats do not change; brands are used at `Map` key types and public method params.
- Non-obvious design decisions: `owner` is typed `OwnerToken`, *not* `SessionId`, because the bash seam is a capability seam whose owner token is documented as deliberately opaque — typing it as `SessionId` would make a generic execution backend depend on the session model.
- Edge cases / failure handling: brands do not validate — a *wrong* session id that is still a well-formed string passes the type checker; only the *category* error is caught. `brandString` performs no runtime check and every boundary trusts the raw string (named as a gap, out of scope).
- Surprising: the bash job id had exactly the same `name-N` shape as `SessionId`'s default, and the model passes `job_id` back — a confusion reachable from untrusted input.

### .agents/notes/archived/architecture/2026-06-20-extract-example-app-packages.md
- Purpose: Turns each example folder from a thick hand-wired demo into a thin invocation of an app package.
- Key abstractions: `@deepseek-ai/dsh-agent-spine-demo`, `dsh-tui-demo`, `dsh-cli-demo`, `dsh-acp-demo`, `@deepseek-ai/dsh-app-boot`; the leaf `cordis.yml` keeps only swappable choices.
- Data flow: the app package owns the composition; the leaf picks backends (LLM adapter, bash executor, model, prompt, persistence root); the shared `base.yml`/`base-core.yml`/`acp-tail.yml` includes are retired.
- Non-obvious design decisions: the ACP front door (stdout purity, agents created through `session/new`) becomes a *property of the artifact* rather than a prose warning — there is no logger entry in the leaf to get wrong.
- Edge cases / failure handling: `hmr` must stay a leaf entry because it is a Loader-only subprocess dev plugin and the in-process vitest tier cannot even import it (class-decorator `@Inject` fails under Vite's transform).
- Surprising: the cost is accepted deliberately: the spine now lives behind a bundle, so "seeing the whole tree" means opening a package.

### .agents/notes/archived/architecture/2026-06-20-generic-long-running-tool-runtime.md
- Purpose: One background-job runtime (`ctx.jobs`) and one set of generic control tools, so bash background tasks and background subagents share an id vocabulary, isolation, cleanup and notice format.
- Key abstractions: `JobRegistry` (Service Definition) + `LocalJobRegistry` (process-local provider); `JobSpec { kind, label, owner?, outputLimitBytes?, run() }`; producer hooks `cancel(reason?)`, `done`, optional `readOutput()`; statuses `running|stopping|completed|killed|failed`; branded job ids `<kind>-N`.
- Data flow: the runtime completes all failable preflight *before* calling `run()`, then commits the registration — a producer can never start work that lacks a collectable id. `dsh-tool-jobs` exposes `job_output` / `job_list` / `job_kill` and injects completion notices.
- Non-obvious design decisions: the snapshot stores the owner's branded `SessionId` for *authorization*, while lifecycle operations retain the exact live `Agent` *instance* — so reusing an agent or session id cannot redirect an old scope's cleanup or notices. Task registrations are **not** effects of the producer tool fiber, so reloading a tool plugin does not kill work owned by an agent.
- Edge cases / failure handling: first-wins settlement — if `cancel` throws, the runtime force-fails the record and warns that work may be orphaned rather than waiting forever; a later outcome cannot overwrite that diagnosis or notify twice. A `wait` timeout is a *successful observation* returning `[status: running]`, not an error. `attachController()` fences start: a producer loaded with no controller fails before execution.
- Surprising: the completion-notice delivery ledger suppresses a notice for work the model already received through a tool result — a wait claims the task, and a `job_kill` claims it when accepted.

### .agents/notes/archived/architecture/2026-06-20-package-hierarchy.md
- Purpose: Restructures the flat `packages/` directory into a uniform `packages/<group>/<pkg>/` depth-two layout.
- Key abstractions: role groups `core/` (product API spine: session, system-prompt, tools, agent, agent-loop), `llm/`, `bash/`, `session-persistence/`, `acp/`, `ui/`, `support/`.
- Data flow: the layout becomes *derivable* — `tsconfig.base.json` maps every package through one `@deepseek-ai/dsh-*` paths wildcard, and `scripts/publint-all.ts` derives its list by reading the hierarchy.
- Non-obvious design decisions: group directories are pure containers (no `package.json`); every package is exactly depth 2 so the workspace glob is a clean `packages/*/*` and one tsconfig wildcard resolves every package.
- Edge cases / failure handling: `scripts/verify-package-paths.ts` flags a `packages/<path>` reference that does not resolve *and* names a real package (a forward-looking proposal naming a package that exists nowhere is left alone); `scripts/check-workspace-constraints.ts` asserts the shape.
- Surprising: a path candidate contains `/*/`, which a naive regex comment-stripper mistakes for a block comment — so `scripts/doc-typecheck.ts` parses the JSONC through TypeScript's own parser.

### .agents/notes/archived/architecture/2026-06-21-mandatory-app-attribution-headers.md
- Purpose: Makes provider-neutral app attribution (`User-Agent` only) mandatory at the LLM adapter boundary.
- Key abstractions: `AppIdentity` in `dsh-llm` (`packages/llm/llm/src/attribution.ts`); `attributionHeaders(identity)` / `userAgent`; default product token `deepseek-harness`, version read from the package manifest via `createRequire` (never a hand-copied constant).
- Data flow: every adapter sends `User-Agent: {product}/{version} (+{url})` on every request; `dsh-llm-deepseek` sets it directly, `dsh-llm-pi-ai` through pi-ai's `StreamOptions.headers` hook (merged last over provider defaults).
- Non-obvious design decisions: OpenRouter's `HTTP-Referer` / `X-OpenRouter-Title` / `X-Title` / `X-OpenRouter-Categories` are explicitly *not* sent — they are a provider-specific product surface, not provider-neutral identity. There is no per-request API for prompt text, session id, cwd, user email or machine identity to influence the fields.
- Edge cases / failure handling: the wire-level mock-server suites assert the exact header value for both adapters, so a pi-ai upgrade that stops delivering it turns the suite red; config-only opt-in attribution was rejected because "a default-off setting is exactly how adapters keep drifting".
- Surprising: a long RFC-based investigation section justifies rejecting `HTTP-Referer` — a marketing-driven header that looks standard but is not.

### .agents/notes/archived/architecture/2026-06-26-file-context-as-event-gate.md
- Purpose: Turns `dsh-fs-observation-policy` from a mandatory method service into an optional event-gate plugin.
- Key abstractions: three `fs/*` events in `dsh-fs` — `fs/write-intent` and `fs/edit-intent` (single-slot, first-wins waterfalls) and `fs/observed` (plain emit); the `expected?` parameter on `writeText`/`editText` (omit = unconditional, present = guarded).
- Data flow: `dsh-tool-fs` dispatches the waterfall with `exec` as the opaque `actor`, then calls `ctx.fs` with the returned expectation, then emits `fs/observed`.
- Non-obvious design decisions: the policy does **no filesystem I/O** — it only chooses the CAS basis; the version check happens inside the provider's atomic mutation critical section, because a policy-side `stat` would leave a TOCTOU gap. The three events live in `dsh-fs` (not the policy package) because the emitter must compile without depending on the policy plugin.
- Edge cases / failure handling: `fs/observed` listeners must be synchronous and non-throwing; the tool does not guard the plain emit, so a throwing listener can replace a pending read error or report failure *after* a mutation already succeeded.
- Surprising: dropping the post-read confirming `stat` makes a follow-up guarded edit occasionally fail-closed under a read/write race — a UX nicety lost, never a correctness hole.

### .agents/notes/archived/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.md
- Purpose: Adds `stdin` and `env` to the bash seam so hook bridges can pass JSON payloads and `CLAUDE_*` variables.
- Key abstractions: `ShellExecRequest.stdin?: string` and `env?: Record<string,string>`, threaded through `ShellExecSpec` into `runBash`.
- Data flow: `resolve()` carries them verbatim; `run()`/`start()` write the bytes to the child's stdin and merge the extra env.
- Non-obvious design decisions: the model-facing tool *omits* both — shell syntax already covers them, and model tool arguments are static JSON that does not expand shell variables. The env merge order is `scrub(process.env, incl. DSH_*)` → `ENV_OVERRIDES` → ordinary `env` → `dshEnv`, so an ordinary `env` entry can never displace a managed value.
- Edge cases / failure handling: `stdin`/`env` are plain optionals, unlike `owner` which is required-but-nullable because a silently missing owner yields a cross-session-readable task. `EPIPE` from a child that exits without reading is ignored.
- Surprising: the two fields are deliberately a *trusted in-process* API, not a new model capability.

### .agents/notes/archived/architecture/2026-07-02-fs-per-session-cwd.md
- Purpose: Makes filesystem resolution agree with bash on the *caller's session* cwd, not a plugin-load cwd.
- Key abstractions: `FileSystem.resolve(path, opts?: { cwd?, signal? })`; the shared `sessionCwd(exec, requestedPath)` helper in `dsh-tool-fs`.
- Data flow: the tool derives `exec.agent?.session.header.cwd` and passes it to `resolve`; the local backend uses `opts?.cwd ?? this.config.cwd`.
- Non-obvious design decisions: the **caller** supplies the cwd because the provider contract must not depend on `dsh-agent`/`dsh-session` — "explicit > implicit at package boundaries". When either the cwd or the path contains `..`, the cwd is resolved to its native filesystem identity *before* any lexical join, because `path.resolve()` erases `symlink/..` lexically while the OS follows the symlink first.
- Edge cases / failure handling: a sandboxed mutation reuses the same resolved `workspaceRoot`, so one call has one workspace identity and the lexical parent receives no grant.
- Surprising: `sessionCwd` returns `undefined` rather than `process.cwd()` when there is no session, so the tool never manufactures a base the provider would otherwise choose.

### .agents/notes/archived/architecture/2026-07-02-result-time-applied-hunk-diffs.md
- Purpose: Gives file mutations a *result-time applied-hunk* diff (±3 context lines) that survives replay.
- Key abstractions: `output.presentationMeta(args, value)` on the canonical tool-output contract; `FsEditOutcome { before, after }` / `FsWriteOutcome { before: string|null, after }`; `ToolResultView { card:'diff'; diffs: FileDiff[] }`.
- Data flow: the backend returns before/after as raw storage facts; the tool computes contextual hunks with the typed `diff` package and projects them as `meta`; the core persists `meta` on the `tool/result` event and replay hands it back to `presentResult` with no I/O.
- Non-obvious design decisions: `presentResult(args, result)` is a *pure* function that runs on live streaming and on replay, so it cannot do I/O — hence a persisted tool-private presentation channel rather than a live diff.
- Edge cases / failure handling: failed mutations carry no diff metadata; `before` is `null` for a create or a binary/non-UTF-8 target, which falls back to a whole-file diff rather than a contextual hunk.
- Surprising: the overwrite path reads the whole prior file into memory to compute a UI-only hunk — tracked as `TODO(overwrite-diff-bound)`.

### .agents/notes/archived/architecture/2026-07-03-filesystem-directory-listing-seam.md
- Purpose: Adds one-level directory enumeration to the filesystem *provider* seam.
- Key abstractions: `FileSystem.listDir(target, signal?)` returning `name`, `type` (`file`|`directory`|`other`), `target`, `version?`, `size?`.
- Data flow: the local backend implements it with `readdir({withFileTypes:true})` plus `resolveLocalTarget` and metadata probes; result order is `name.localeCompare` for determinism and prefix-cache reuse.
- Non-obvious design decisions: the provider capability and the model-facing UX are separate decisions — `listDir` lists one directory level only, and recursive traversal, globbing, pagination, search and file watching are explicitly out of scope, so the smallest backend contract future consumers can safely compose is the one shipped.
- Edge cases / failure handling: broken or disappeared children are represented as `type:'other'` without metadata and do not abort the listing, but a permission or I/O failure while *resolving* a child fails the whole listing with a structured `FsError`.
- Surprising: there is deliberately **no** model-facing `ls` tool — the provider capability and the model UX are separate decisions.

### .agents/notes/archived/architecture/2026-07-05-subagent-provider-lifecycle-events.md
- Purpose: Removes an implicit load-order requirement between the subagent tool and its provider.
- Key abstractions: `subagent/provider-added(provider)` and `subagent/provider-removed(name)` typed events.
- Data flow: `dsh-tool-subagent` registers the tool when a provider becomes resolvable (deriving the description from `provider.inheritsParentContext` at that moment), unregisters when it goes, and re-derives on HMR re-registration.
- Non-obvious design decisions: the tool's description is fixed at *registration* (it is where tool-choice guidance lives), but the provider arrives on its own fiber with no schedule — so the tool mirrors the lifecycle instead of resolving at `apply` time. "Async state is not synchronous state."
- Edge cases / failure handling: addition fails loud; removal is contained per listener so one throwing listener cannot starve later mirrors or disrupt teardown. `start()` still resolves the provider by name for every run, preventing stale tools from calling a removed backend.
- Surprising: the honest state during an HMR reload is that the model sees *no* subagent tool — "the alternative is a tool that dispatches into nothing".

### .agents/notes/archived/architecture/2026-07-05-windows-fs-permissions.md
- Purpose: Makes atomic write permissions behave correctly on Windows, where mode bits are synthetic.
- Key abstractions: the staging directory is created inside the target's *parent* directory so it and the temp file inherit the destination DACL.
- Data flow: POSIX keeps `0o700` staging + `0o600` temp; Windows relies on directory inheritance.
- Non-obvious design decisions: explicit owner-only DACLs for new files were rejected because they would break inheritance and surprise users whose project directories are deliberately shared; replacement writes copy the target's existing DACL instead.
- Edge cases / failure handling: tests assert mode bits on POSIX only; a test-side `Get-Acl` SID allowlist was rejected because `icacls` localizes well-known account names, making parsing locale-fragile.
- Surprising: mode preservation across a replace degenerates to a no-op on Windows — a writable file probes as `0o666` and replaying that through `chmod` leaves the read-only attribute clear.

### .agents/notes/archived/architecture/2026-07-05-windows-jsonl-durable-publish.md
- Purpose: Gives the JSONL session log a durable publication primitive on Windows, where a POSIX parent-directory fsync contract does not exist.
- Key abstractions: a platform fork inside `materialize()`; Windows publishes via `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without `MOVEFILE_REPLACE_EXISTING` or `MOVEFILE_COPY_ALLOWED`, using `koffi` as the minimal Win32 bridge.
- Data flow: shared code computes the session directory, final log path and encoded header + first event batch; POSIX does temp-write → fsync → `link()` → dir fsync → unlink; Windows creates a random sibling directory under the constant `.dsh-mkdir-` prefix and publishes it with a write-through move.
- Non-obvious design decisions: treating Windows directory-sync failures as success was rejected because it reports a first append as durable without forcing the published namespace entry to stable storage.
- Edge cases / failure handling: a failed append closes its append-only handle, reopens the log read/write, truncates it to the pre-append size and fsyncs the rollback, because Windows rejects `ftruncate` on append-only handles.
- Surprising: `CreateHardLinkW` was rejected (filesystem-dependent, no write-through, cannot publish directories) and `ReplaceFileW` conflicts with same-id collision rejection.

### .agents/notes/archived/architecture/2026-07-06-tool-result-retention-library.md
- Purpose: A shared, mechanical answer to "what did we keep, and what did we omit?" for every bounded model-facing tool.
- Key abstractions: `ItemRetainer<T>` (head-only, item counts) and `TextRetainer` (head / tail / headTail, byte budgets); `Omitted = {kind:'none'} | {kind:'exact',count} | {kind:'unknown'}`; `PushDecision {kept, truncated}`; `RetentionNotice` + `formatRetentionNotice`.
- Data flow: callers push every observed item/chunk and get a decision per push; omission counts are exact because nothing is dropped before it is counted. The library is a plain library — no `ctx`, no plugin, no cross-call state.
- Non-obvious design decisions: `truncated` means "the retainer omitted otherwise-available content because of a budget" and *never* means "the upstream was incomplete" — tool-specific states (`incomplete`, permission failures, binary skips, provider partial failures) stay in tool-domain fields. `read` is deliberately out of scope: it is a line-window renderer, not generic retention, and one `Omitted` count cannot represent both sides of a window.
- Edge cases / failure handling: text retention preserves UTF-8 boundaries at `finish()` (2-, 3- and 4-byte codepoints and invalid lead bytes at each cut).
- Surprising: the recovery advice stays with the tool ("Narrow the pattern, path, or include") — the library supplies the omission fact, not the remedy.

### .agents/notes/archived/architecture/2026-07-08-agent-scope-contexts.md
- Purpose: Makes the agent a *registration scope* — one flat layer of per-agent registrations alongside deployment-global ones.
- Key abstractions: `agent.ctx`; the four-rule contract table (register locally / see globals+local / scoped listeners / lifetime); `Scoped<T>` as an opaque routing receiver; `TurnTriggerMap` extension for the `injection` trigger.
- Data flow: registration *origin* chooses visibility and cleanup (plain plugin ctx → global; `agent.ctx` → exactly that agent); the *operation* chooses the view (tool lookup, prompt assembly and event dispatch receive the real agent).
- Non-obvious design decisions: the scope is flat — resolution never walks parent or sibling scopes, and lifetime ownership does not imply registration inheritance. `agent.ctx` deliberately has no reverse `agent` property; the subject is passed explicitly.
- Edge cases / failure handling: creation publishes last and disposal revokes last; a failure at any phase rolls the private transaction back before either identity is announced, and every creation announcement that begins has a matching disposal announcement during rollback.
- Surprising: "Security and authority are non-goals" — a parent may own a child whose visible tools are *wider* than its own, because lifetime ownership does not donate or cap registrations.

### .agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md
- Purpose: Moves compaction pressure measurement to a post-call boundary and adds a bounded context-overflow recovery path.
- Key abstractions: `CompactionEngine.compactIfNeeded(agent, trigger, signal)` with `trigger: 'pressure' | 'context-overflow'` (no estimation methods — `ctx.tokenMeter` owns accounting); `agent/request-error` as the recovery seam.
- Data flow: compact-basic wraps `agent/pre-step` and measures the canonical *logged* envelope via the singleton `ctx.tokenMeter`; on canonical overflow it prunes first, then chooses the maximal tool-balanced head range and attempts one shrinking summary compaction, then returns `{kind:'retry'}`.
- Non-obvious design decisions: recovery is authorized only by a proven `session.surface.replaceGeneration` change — a backend returning a result without replacement cannot authorize a retry, while pruning-only progress can. Retry opens a *new* turn from the durable log rather than retrying the same numbered step, preserving balanced nesting.
- Edge cases / failure handling: noncanonical errors, exhausted attempts, an aborted signal, a missing routed model, no safe range, no generation change, and recovery throws before any replacement all delegate to the next listener; with no later recovery the loop reports the original provider error object and code. `maxOverflowRetries` defaults to `1`, `0` disables overflow recovery without disabling pressure.
- Surprising: provider *wording* is classified at the adapters, not by the compaction plugin — and both DeepSeek adapters normalize recognized provider context-limit failures to `CONTEXT_WINDOW_EXCEEDED`.

### .agents/notes/archived/architecture/2026-07-12-agent-scope-runtime-design.md
- Purpose: The correctness argument behind the agent-scope contract across cooperative plugins, async creation, reentrant listeners, durable commits and process failure.
- Key abstractions: one mechanism per fact — opaque scope key + shared layer store; one registry entry per live object; one `AgentCreationTransaction`; materialize-once at real data boundaries; one shared tool view + the authoritative assembly-waterfall result.
- Data flow: publication is ordered (enter session → enter agent → announce `session/created` → await serial `agent/created` → release queued input); teardown is the reverse and revokes registrations last.
- Non-obvious design decisions: **trust boundaries are typed by ownership change** — a typed in-process call borrows readonly values, while parser/queue/model/durable/worker/process/wire boundaries materialize. A trusted `system-prompt/assemble` listener may replace PTC-mode and structured-output protocol pieces and "owns preserving a coherent protocol".
- Edge cases / failure handling: append has one commit point — pre-commit listeners can veto, post-commit observers cannot, and no observer error makes a committed event look uncommitted. Three execution boundaries are deliberately one-way (tool pre-policy denies monotonically; tool result observes the immutable committed outcome; turn continuation concludes through the committed result).
- Surprising: the structured-output tool stages a value but commits it only from an immutable `tools/result` observation, and in PTC mode only when the enclosing `run_code` execution also succeeds — program failure discards the pending value.

### .agents/notes/archived/architecture/2026-07-12-scoped-layers-store.md
- Purpose: One shared primitive for the seven registration facades that need "global layer + one exact agent layer".
- Key abstractions: `ScopeLayer` (`isEmpty()`), `ScopedLayers` (`global`, `peek`, `merge`, `effect`), `NamedEntries<V>`, `AnonymousEntries<V>`; `EntryValues` stays internal.
- Data flow: `effect()` derives the scope key with `scopeOf(ctx)`, attaches the action to that same `ctx.effect()`, collects the undo *before* calling `onChange`, and returns the exact `ctx.effect()` disposer.
- Non-obvious design decisions: the public disposer must be the *exact* function returned by `ctx.effect()` — wrapping it breaks Cordis's identity-based ordered teardown. Undo must be collected before a change callback runs so a throwing callback rolls the mutation back.
- Edge cases / failure handling: draining a table starts a new generation so an in-flight iterator cannot observe a self-replacement; a scoped layer is reclaimed only when its complete aggregate is empty, so disposing one facade cannot discard sibling contributions of the same scope.
- Surprising: `merge()` is the only materialized generic read — `peek`/`merge` never create a scoped layer.

### .agents/notes/archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.md
- Purpose: Provider-neutral *advisory* model discovery plus per-session ACP model selection.
- Key abstractions: `LlmAdapter.providerInfo(provider)` and `listModels(provider)`; `LlmProviderInfo {id,name}` / `LlmModelInfo {provider,id,name,description?}`; `installModelSelection` (scoped `system-prompt/assemble` + `agent/request` listeners).
- Data flow: `LlmRuntime.listProviders()` returns detached metadata in registration order; `listModels(provider)` validates and returns detached values; the selection is snapshotted once per step and pinned for the whole admitted ACP turn.
- Non-obvious design decisions: catalog membership is **advisory** — it never changes `stream()` routing and never rejects an otherwise valid request, because the hand-written DeepSeek adapter deliberately forwards arbitrary model ids to a private endpoint. A selection that is never used by a request is intentionally in-memory only.
- Edge cases / failure handling: provider metadata is validated atomically during `registerAdapter()` so a malformed display record cannot leave a partial registration; a mismatched provider or duplicate model id is rejected with `INVALID_CATALOG`, an unknown provider with `NO_ADAPTER`.
- Surprising: the same model id may appear under multiple providers, so every choice carries the full provider/model pair.

### .agents/notes/archived/architecture/2026-07-15-lsp-capability-seam.md
- Purpose: A three-package LSP seam (`dsh-lsp` / `dsh-lsp-stdio` / `dsh-tool-lsp`) with one read-only model tool.
- Key abstractions: `LspOperation` = `goToDefinition | findReferences | goToImplementation | hover`; `LspProviderId` branded; `LspQueryResult` = locations | hover; `LspProvider.query(request, signal?)`.
- Data flow: the tool validates model args (`file_path`, one-based `line`/`character`) → converts to zero-based UTF-16 `LspPosition` → `ctx.lsp.query` → the stdio provider resolves/contains the source through `ctx.fs`, streams it, sends `textDocument/didOpen` (version 1), the request, then `didClose` in `finally`.
- Non-obvious design decisions: documents are opened *transiently* per query (close after each call), so the MVP needs no `didChange`/cache/eviction state machine; the seam exposes no generic JSON-RPC escape hatch; the seam adds no hidden timeout — only the tool attaches a `timeoutMs` budget (default 60 s).
- Edge cases / failure handling: registration is atomic (invalid input or any conflict publishes nothing, and the disposer releases all reservations); extension ownership is exclusive (two providers cannot both claim `.ts`); a close-write failure invalidates the instance and awaits bounded process termination but does not replace the settled result.
- Surprising: the LSP provider deliberately does **not** emit `fs/observed` — only the LSP result is model-visible, so the query does not satisfy read-before-write policy.

### .agents/notes/archived/architecture/2026-07-15-replay-token-meter-service.md
- Purpose: One replay-aware owner for the "how many tokens does this durable request consume?" question.
- Key abstractions: `ctx.tokenMeter` with `measure(session, requestHeader?)` and `estimateMessage(message)`; a fixed four-characters-per-token heuristic plus structural overhead; per-session incremental folds advanced from `session/event`.
- Data flow: each session owns one isolated fold that catches up through the durable tail on every read, so listener ordering, seeded sessions and service reload do not change the answer; each result is one detached, deeply immutable snapshot carrying one `logRevision`.
- Non-obvious design decisions: provider usage is reused **only** when the measured canonical request envelope equals the latest successful-call anchor — any provider/model/system/prefix/tool/call-config change causes complete heuristic repricing. Surface changes remain a *signed* delta, including negative values after a shrinking replacement.
- Edge cases / failure handling: a malformed next event fails transactionally and remains unread rather than partially mutating state; measurement fails loudly on corrupted replay rather than silently drifting pressure.
- Surprising: the service deliberately has **no configuration** and no model profiles — exact capacity is an adapter-owned query and the threshold/retention policy belongs to compaction-basic.

### .agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.md
- Purpose: A typed, turn-scoped cancellation capability with an explicit signal.
- Key abstractions: runtime-only `AgentCancelCause` = `{kind:'user'} | {kind:'parent'} | {kind:'hook';reason} | {kind:'disposed'}`; one `TurnCancellation` per prospective turn holding a single `AbortController`; the durable outcome `{kind:'aborted'}`.
- Data flow: the holder is installed before `agent/status = running` and retained through inbox claim, `agent/pre-step`, prompt assembly, every step, model and tool execution and `agent/turn-stopping`, then cleared immediately before publishing `turn/end`.
- Non-obvious design decisions: the cause is *not* frozen — undici assigns a `stack` onto the abort reason, and a frozen reason makes `fetch` reject with `TypeError: Cannot add property stack`; so the loop copies the declared fields where the cause becomes durable. Terminal events never carry the cause: session seed/load rejects legacy aborted records with a reason.
- Edge cases / failure handling: terminal classification order is disposed → supported cause → error path; the cause reason cannot be rewritten once cancellation won. Work queued by a notification observer is cleared by that cancel, while work queued by a later signal-abort observer is latched and runs when the aborted activity converges to idle.
- Surprising: cancellation is cooperative and deliberately does *not* use `Promise.race` — uncooperative in-process work must settle before `whenIdle()` reports quiescence, because returning idle while work still runs would break teardown.

### .agents/notes/archived/architecture/2026-07-17-local-spill-startup-cleanup.md
- Purpose: Bounds the lifetime of spilled tool-result files without a timer or a session-lifecycle coupling.
- Key abstractions: `cleanupPeriodDays` (default 30, `0` disables); a one-shot best-effort sweep owned by the plugin fiber (`ctx.effect` whose generator yields an async disposer awaiting the sweep).
- Data flow: the sweep scans the configured/active root plus prior default `dsh-spill-*` temp roots, deleting regular files whose `mtime` is strictly older than the cutoff; empty session directories are pruned, and a discovered prior-default root is removed entirely.
- Non-obvious design decisions: path-based deletion is restricted to directories an untrusted local OS user cannot replace during the scan — on POSIX every root and session directory must be owned by the current user and not group/other writable, and the root's ancestor must be non-writable or protected by a sticky directory. `lstat` is used so a symlink is never followed.
- Edge cases / failure handling: every filesystem failure and even a warning-sink exception is contained — the sweep never throws, so it cannot reject activation or a concurrent spill write. Root aliases are de-duplicated by device/inode identity.
- Surprising: the same-user account is the trust boundary, consistent with the backend's private local-storage model.

### .agents/notes/archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md
- Purpose: The host/client layering model plus a channel-independent RPC protocol for every product client (Web, Electron, in-process).
- Key abstractions: `packages/host/*` (apiproxy = protocol front layer, runtime = assembly, webserver = carrier) and `packages/client/*` (pure libraries, static-arrival entries, fetch-arrival plugin packages); `ApiProxy = { sessions, host, events, respond }`; `RpcMethodMap` → derived `RequestPayload<K>` / `ResponseValue<K>`; `AbstractApiClient` with `doFetch` (transport) and `onEnvelope` (observation) as the only two aspects.
- Data flow: the loop's `SessionEvent`/`ContentBlock` types cross the wire verbatim (no DTO layer) through `import type`; the client validates with zod at two levels (envelope, then business payload) and narrows with `switch (message.type)`.
- Non-obvious design decisions: the wire has exactly four message kinds classified by "who initiates × request/response", decoupled from the physical channel — so swapping HTTP/SSE for WebSocket/IPC leaves the protocol unchanged. `rpcId` is minted by whoever initiates and a response *echoes* it, never mints. `RpcReceipt` is a carrier receipt, not an RpcMessage (a response has no response). `Wire<T>` widens `| undefined` because `exactOptionalPropertyTypes` makes zod's `.optional()` unusable.
- Edge cases / failure handling: reserved-method discipline — the map holds only implemented methods and an unknown method fails loud at envelope parse (`bad-request`), with no not-implemented fallback. `host.describe` has no protocolVersion because client and host release bound together.
- Surprising: `InProcessApiClient(toFetchHandler(api))` never touches the network yet runs the real wire serialization, zod and SSE framing — the isomorphic point where protocol tests run without a port.

### .agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.md
- Purpose: The browser side — how the client Cordis tree loads, how UI plugins compose through slots and services, and how a React-free object layer feeds React through immutable snapshots.
- Key abstractions: `ctx.connection`, `ctx.slots`, `ctx.sessions`, `ctx.loader`, `ctx.theme`, `ctx.i18n`, `ctx.layout`, `ctx.conversation`; `ObservableSnapshot<T>` (`getSnapshot`/`subscribe`); `bindSnapshotSelector`; the `ConversationNodeAssembler` (Definitions → Contexts → view builders).
- Data flow: `$events` frames → `SessionManager` → `Session.handleMuxEnvelope` → contiguous event window → `ConversationNodeAssembler` → `ConversationSnapshot` cache → `useSyncExternalStore` → components.
- Non-obvious design decisions: React is *pure projection* — components import nothing from the framework, receive everything through props, and subscribe to immutable snapshots. The notifier has two channels chosen by change source: `markDirty()` (frame-driven) batches per microtask, `notifyNow()` (direct echo of a user gesture) notifies in the same tick, because controlled inputs roll the DOM back and jump the caret if their echo defers to a microtask.
- Edge cases / failure handling: reconnect = rebuild (no resume cursor): reopen the stream + refetch history, compare `subscribed.lastSeq` with the history tail and backfill once on a gap. The ConnectionController reconnects with exponential backoff (500 ms doubling to 10 s, jitter, unlimited) behind a generation fence.
- Surprising: one-flip boot — every entry must reach ACTIVE before the UI mounts at all, with FAILED/PENDING fibers listed loud; there is no progressive-availability mode.

### .agents/notes/archived/architecture/2026-07-19-package-invariant-runtime-contracts.md
- Purpose: Decides which packages may publish a runtime invariant companion, and what a published companion must actually assert.
- Key abstractions: `./invariant` companion packages; `ctx.invariants`; a bound `fail(message)` reporter; `verify-package-invariants` (AST rule rejecting generated markers, default exports and empty installers).
- Data flow: a companion installs a package-owned check over an event stream or mutable structure and reports violations through its bound reporter; session-backed companions validate existing durable events at load using the prefix preceding each candidate.
- Non-obvious design decisions: a published assertion must relate observations *over time* (a terminal event without its start, an LLM delta for a block that is not open, a durable result whose identity differs from its request) — method-presence and plugin-shape assertions are explicitly rejected as duplicating stronger type/load/unit gates.
- Edge cases / failure handling: a package with no plausible relationship omits the companion and records the reason in its README; the omission is checked by the gate, so the README is the audit trail.
- Surprising: the central `dsh-invariants` service is product-independent and imports no product package — the checks live next to the data that can violate them.

### .agents/notes/archived/architecture/2026-07-19-package-owned-invariant-service.md
- Purpose: The `ctx.invariants` registry service, its selection policy, and the package-owned contribution contract.
- Key abstractions: `Config { enabled?, package_allowlist?, package_blocklist? }`; `selected(enabled, allow, block, packageName)`; `ctx.invariants.register(packageName, installer)`; `InvariantInstaller.inject`; `InvariantError` with code `INVARIANT`.
- Data flow: a registration reserves one name per npm package even when filtered; an enabled installer runs in a dedicated child Cordis fiber owned by the service, and the service joins the returned installer promise so async startup checks stay transactional.
- Non-obvious design decisions: allow/block entries are *case-sensitive JavaScript regex sources* compiled with `new RegExp`, unanchored unless the caller supplies `^`/`$`; blocklist beats allowlist; a source matching no loaded package stays valid because registration order, later loading and HMR must not change config validity.
- Edge cases / failure handling: if an installer fails after registering listeners, the child fiber is disposed completely and the name reservation released before the failure escapes; a filtered registration creates no child but keeps its reservation.
- Surprising: the former functional-plugin entry point and one-argument `InvariantError` constructor were *not* kept as compatibility APIs — the repo is pre-release and all call sites moved together.

### .agents/notes/archived/architecture/2026-07-19-zstandard-jsonl-session-logs.md
- Purpose: Zstandard framing for the JSONL session log, with the append/fsync boundary preserved.
- Key abstractions: `compression?: 'zstd' | 'none'` (omission resolves to `'zstd'`); a standard concatenation of independent checksummed Zstandard frames (one header frame, one frame per durable append batch); `SessionLocation.kind` stays `'jsonl'` for both encodings.
- Data flow: the artifact is a frame sequence; a frame-boundary scanner validates magic, headers, block headers and checksum trailer; complete frames go through the large-session restore pipeline, and listing reads only the first complete frame (so metadata-only listing works for very large logs).
- Non-obvious design decisions: one frame per *durable batch*, not per record — per-record framing would multiply headers and checksums for high-volume chunk events and put the physical boundary in the wrong place. Each persistence root belongs to one encoding; a discovery preflight rejects the opposite suffix and there is no dual read, dual write or extension-based fallback.
- Edge cases / failure handling: EOF inside the final frame is a torn tail — repair truncates from that frame's starting byte, keeps all prior complete frames, and appends the synthetic closers as one new frame. A checksum/decompression failure in a *complete* frame is corruption and rejects.
- Surprising: the implementation uses Node's *experimental* built-in `zstdCompress`/`zstdDecompress`, so the Node 22.19/24/26 compatibility gate exercises the exact helper.

### .agents/notes/archived/architecture/2026-07-20-canonical-tool-output-contract.md
- Purpose: One canonical, typed tool output per execution, with an explicit projection into model-facing content.
- Key abstractions: `output: { schema, render(args, value), presentationMeta?(args, value) }`; `ToolExecutionResult` as a discriminated union over `isError`; `JsonValue` as the lossless snapshot type.
- Data flow: the registry snapshots the returned value as lossless `JsonValue`, validates it against `output.schema`, deep-freezes it, then invokes the pure renderer and (for a direct surface call) the metadata projector; renderer/projector/schema/JSON failures become ordinary `ToolOutputError` results.
- Non-obvious design decisions: canonical values are *execution-local* — the `tool/result` event persists only `content`, `error` and optional `meta`, so replay reproduces presentation but cannot reconstruct the programmatic result. `tools/post-execute` has two mutually exclusive successful projections: replacing `content` changes only presentation; replacing `value` revalidates and recomputes both.
- Edge cases / failure handling: an around `tools/execute` wrapper's authored success is normalized again through the resolved tool's output declaration, and each canonical result is tied to the immutable dispatch token that created it — so returning a cached result from another call is re-normalized rather than trusted.
- Surprising: "content replacement is not a confidentiality mechanism" — policy that must prevent programmatic access blocks the call or replaces the *value*.

### .agents/notes/archived/architecture/2026-07-20-todo-event-ownership.md
- Purpose: Puts the `todo/write` event type and its payload in the package that produces them.
- Key abstractions: `TodoItem` declared by `@deepseek-ai/dsh-tool-todo` and merged into `@deepseek-ai/dsh-session/types` from its type-only outlet; the `todo` invariant companion.
- Data flow: the merge-extensible `SessionEventMap` switch in core session falls through for `todo/write`; the todo companion validates the payload and the event's relationship to an open turn before append, and validates existing and newly announced sessions in one pass.
- Non-obvious design decisions: rendering reuse does not make core the semantic owner — a consumer that names or narrows `todo/write` declares a *type-only* dependency on the todo package, and the emitted JavaScript has no todo import.
- Edge cases / failure handling: a composition does not need to mount the todo tool merely to search, transmit or render a log that may contain `todo/write`.
- Surprising: "reachable-but-unadvertised is a door the model has to guess at" — the same reasoning that later made `list_facts` a core tool.

### .agents/notes/archived/architecture/2026-07-20-unified-json-value-schema-dsl.md
- Purpose: One JSON-value schema vocabulary shared by tool parameters, tool outputs and structured subagent output.
- Key abstractions: `ValueSchemaSpec` (author form, any JSON root), `ParameterSchemaSpec` (implicit object-property map with per-property `required: true`), `JsonSchemaNode` (raw wire form); `InferValue<S>` / `InferArgs<P>`; `assertSupportedJsonSchema()`; `validateJsonSchemaValue()`.
- Data flow: the same declarations compile to JSON Schema (`valueSchemaSpecToJsonSchema()`) and infer TypeScript values, so validation, code generation and inference cannot disagree.
- Non-obvious design decisions: an explicit author object must declare `additionalProperties: true | false` — either default would hide a consequential author decision. `oneOf` is exact-one, not first-match, so branch ordering cannot change validation semantics. Exact inference is bounded to 16 container levels and then degrades to `JsonValue`, so TypeScript's instantiation depth is not the authoring limit.
- Edge cases / failure handling: the lossless `JsonValue` boundary rejects `undefined`, negative zero, non-finite numbers, sparse arrays, cycles, exotic objects, functions and symbols; runtime nesting is limited by memory rather than the JS call stack (explicit work stacks).
- Surprising: raw JSON Schema is accepted for MCP/external tools, but unified code generation treats *unsupported* schemas as unknown instead of pretending to enforce them.

### .agents/notes/archived/architecture/2026-07-22-tui-interactive-extension-service.md
- Purpose: Gives plugins a supported way to open a modal overlay in the TUI without capturing its internals.
- Key abstractions: `ctx.tui` (provided after terminal startup succeeds, gone before teardown); `ctx.tui.openOverlay()`; a private FIFO overlay manager; a frozen host facade (viewport, theme functions, display-text escaping, redraw, close, lifetime signal).
- Data flow: the service method runs through Cordis's traceable service proxy, installs an effect on the *calling* plugin fiber before admitting the request, so caller disposal removes a queued request or closes an active overlay.
- Non-obvious design decisions: the factory never receives the pi-tui `TUI`, overlay handle, editor, transcript tree, focus controller or terminal object — those would make private focus/rendering state a public compatibility contract. The model selector and the question panel use the *same* manager, so all modal interaction has one focus owner.
- Edge cases / failure handling: component construction, rendering, input and invalidation run behind an exception boundary — a failure closes that request with an `error` outcome, reports a visible terminal error, and lets the queue continue.
- Surprising: overlay state is deliberately *not* in the session log and not rebuilt during resume; modal presentation is not model-visible session state.

### .agents/notes/archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md
- Purpose: Collapses three delivery verbs (`send`, `steer`, `inject`) into one primitive plus three presets, and merges injected context into `user/message`.
- Key abstractions: `Agent.send(message, target, wakeup)` over the (target × wakeup) matrix; presets `followup` (next-turn/wakeup), `steer` (next-step/wakeup), `inject` (next-step/no-wakeup); `UserMessage` owning identity, role, content and producer `source`; `agent/inbox/spliced` durable coordinates.
- Data flow: every append/prepend/edit/remove/cancel/claim records normalized durable splices; insertions emit `agent/inbox/inserted`, ordinary removals emit `agent/inbox/discarded` with `outcome:'canceled'`, and the loop's atomic `claim()` emits `agent/inbox/claimed { message, turn }`.
- Non-obvious design decisions: command mode is *not* a separate state — `context/message` is deleted and "is this a human prompt?" becomes a `source.kind === 'user'` test, so every consumer simplifies to one check. `wakeup` is the "should the model run" signal, so a lone next-turn/no-wakeup item stays parked and rides the next waking send.
- Edge cases / failure handling: pre-step claims next-step input without making it a separate turn; rejection and listener failure leave the claimed batch removed, and input arriving after the claim waits for a later boundary. `cancel(cause, { keepInbox })` can abort the active turn while preserving queued work.
- Surprising: an idle injection stays pending *without* opening a turn or running the model, then becomes `user/message` when a later waking delivery's pre-step returns it in the entering batch.

### .agents/notes/archived/architecture/2026-07-23-toolview-dissolution.md
- Purpose: Retires the standalone tool registry so tool rows are per-view keyed slots.
- Key abstractions: keyed child slots; `ctx.slots.inject('tool.call.toolview', …)`; the runtime-open key space (`SlotMap` declares slots, never keys).
- Data flow: a business package registers an atomic view through one `inject` + `register` call; the declaration *is* the load and reload dependency.
- Non-obvious design decisions: the original justification (tool names are a runtime-open set while `SlotMap` is a closed table) was hollow — a keyed slot's *key space* is already runtime-open, so the open tool-name set fits `entryKey` dispatch natively.
- Edge cases / failure handling: same-key double registration is now a *loud throw* where the registry previously let later-wins silently override — a discipline correction. There is no third-party registry-level shape override; a real need routes through key-naming conventions.
- Surprising: a thin `registerToolView` facade over `slots.register` was deliberately left unbuilt — "a facade is not an enforcement point", so it would carry only compile-time sugar.

### .agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md
- Purpose: One session query service instead of separate exact-read and full-text keys.
- Key abstractions: `SessionQueryService` registered as `ctx.sessionQuery`; a backend-independent `SessionCorpus`; only `searchSessions()` and `searchEvents()` are abstract; `SessionQuerySqlite` as the sole concrete backend.
- Data flow: one mounted instance exposes listing, title/event reads, surface reads, filtering and relationship tracing; the SQLite-owned half observes sources, reconciles the derived FTS index, ranks matches and owns cursor generations.
- Non-obvious design decisions: the service deliberately retains *two internal observation strategies* — exact operations read authoritative live/persisted sources per call, while full-text operations reconcile a disposable index; sharing the context key does not make the derived index authoritative.
- Edge cases / failure handling: SQLite reconciliation is one quiescent serialized state machine that checks cancellation after every await and before starting the next operation, so a cancelled call cannot release the serializer while a backend call is still cleaning up.
- Surprising: a production composition must choose a concrete backend even when a consumer only calls inherited exact methods — a partial surface is not mountable.

### .agents/notes/archived/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md
- Purpose: Makes reasoning strength an adapter-owned capability rather than core configuration.
- Key abstractions: opaque branded `ReasoningEffortId`; one adapter-owned `resolveModel(provider, model, signal?)` returning `LlmResolvedModelInfo`; `LlmRuntime.resolveModelInfo()`; `LlmCallConfig`/`GenerateOptions` carrying the optional effort.
- Data flow: the agent loop prepares the post-`agent/request` config under the active turn signal *before* writing `request/header`, so defaults and dynamic changes become durable facts before dispatch; the prepared call retains the exact adapter registration across async resolution, header logging and dispatch.
- Non-obvious design decisions: the core never clamps or aliases a value — an unsupported effort fails with `UNSUPPORTED_REASONING_EFFORT` before provider I/O, because a silent substitution makes the user's control differ from the logged request intent. The core requires the selected effort to appear exactly in the adapter's list.
- Edge cases / failure handling: a resumed loop retains the logged effort only when its initial provider/model route is unchanged; a route change discards the previous model's opaque id. A `thinking: disabled` deployment publishes only `off` and rejects enabling thinking before provider I/O.
- Surprising: pi-ai's own `ThinkingLevel` union stays *out* of core — canonical names are an adapter implementation detail.

### .agents/notes/archived/architecture/2026-07-24-dsh-commander-argument-adapter.md
- Purpose: Parses `dsh` argv exactly once, through one Commander adapter.
- Key abstractions: `parseDshArgs(argv, version)` returning a discriminated `DshInvocation` union (`{mode:'tui',config?,resume?}` | `{mode:'headless',prompt}` | `{mode:'web',host?,port?,dev}`); `RESUME_SESSION_ID_KEY` provided on the boot context via `ctx.provide`.
- Data flow: `bin.ts` calls the adapter once and switches on `mode` (closed union, `satisfies never` default), dynamically importing only the chosen mode's module; each mode module consumes already-parsed values and never re-reads argv.
- Non-obvious design decisions: help/version/errors are *not* modelled as data — Commander owns them, and `exitOverride()` turns each into a thrown `CommanderError` that one `try/catch` converts to `process.exit`. The default surface takes no positional argument, which is what lets `web` be a real subcommand without a positional collision, so `dsh --help` lists `web` natively.
- Edge cases / failure handling: domain checks Commander cannot express are done with `command.error(...)` (print + exit 1) — `--prompt` selects headless and rejects an empty task or a `--config`/`--resume` alongside it; a leaked `--config`/`-p`/`--resume` on the `web` subcommand is rejected rather than silently dropped. Host/port validity is the webserver schemastery `Config`'s job at boot, not the adapter's.
- Surprising: `--resume` is delivered through the *boot context* (`ctx.provide`) rather than an environment variable, because the bin already holds the parsed value and threading it through env was indirection with no benefit.

### .agents/notes/archived/architecture/2026-07-24-project-session-directories.md
- Purpose: Replaces hashed cwd buckets with readable project directories and gives each session its own directory.
- Key abstractions: `<root>/--<normalized-cwd>--/<encoded-session-id>/session.jsonl.zstd`; `~XXXX` escaping for unsafe code units; a bounded readable project name.
- Data flow: `create()` performs no filesystem I/O; the first append creates the project/session directories before collision-safe transcript publication; empty directories are not listed as sessions.
- Non-obvious design decisions: the project key intentionally has *no hash suffix* — the normalization is lossy (`/a/b-c` and `/a-b/c` share one directory) and the note accepts that in exchange for a name a human recognises, because distinct session ids still select separate session directories.
- Edge cases / failure handling: case-insensitive filesystems can make differently cased keys one physical directory; identity validation accepts an alternate spelling only when canonicalization resolves both to the same transcript, and a different canonical path remains corruption. Flat `<project>/<id>.jsonl*` artifacts are rejected with an explicit layout error (no automatic migration).
- Surprising: the session id names an *ownership directory*, not the transcript — so the backend can add session-owned artifacts (metadata, attachments, spill) without another layout change.

### .agents/notes/archived/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.md
- Purpose: How `dsh web` composes (cordis.yml + boot classes + config sources) and how the web transport splits across packages.
- Key abstractions: `apps/cli/config/base.cordis.yml` + `web.cordis.yml` as one flat assembled tree; `AppCLIEntry` / `AppWebEntry` as a boot-glue class pair; `ctx.webServer.register(route)`; `ctx.clientModules`; `BootManifest` (npm-package rows vs cordis-plugin rows).
- Data flow: `AppCLIEntry.run()` is three stages — layered env (ambient > cwd `.env` > `$DSH_HOME/.env`) → patch composition → Loader include boot plus the activation audit. `AppWebEntry.run()` parses `window.__DSH_BOOT__`, builds the module system, renders the loading page, prefetches the `immediately` tier, then creates the graph rows and sweeps.
- Non-obvious design decisions: the browser must **await the prefetch before creating entries**, because materialization is a synchronous `tree.import` require unprotected by fiber inject waiting, and cross-package require edges (i18n → runtime/client) need every immediately-tier factory registered first — an empirically found 10–25% boot race otherwise.
- Edge cases / failure handling: `auditStartupEntries` reports failed imports, reads failed fibers for original activation errors, and lists services leaving a fiber `PENDING`; `installFailLoud` coalesces Loader's duplicate notification through one process checkpoint so unrelated unhandled rejections stay fatal.
- Surprising: a `declare module 'cordis'` augmentation in a file with **no cordis import** is demoted to a standalone module declaration and silently shatters the program-wide `Context` merge — anchor with `import type {} from 'cordis'`.

### .agents/notes/archived/architecture/2026-07-25-web-client-session-scope-and-provide-channel.md
- Purpose: Client-side Agent-scope parity (`actx`) plus the per-session provisioning channel.
- Key abstractions: `createScope(ctx, key)` (a no-op plugin fiber + `extend({[kScope]: key, [Context.filter]: …})`); `sessions.retain(target, options)` / `reference.ready`; `uiSession.provide({hooks, props, resolve})`; slot scope `root | session-maybe | session`.
- Data flow: dispatch is `actx.bail(actx, event, req)` / `actx.emit(actx, …)`; `Session.bindScope(actx)` pairs exactly once; the reverse actx→Session direction is one hop through `sessions.sessionOf(actx)`.
- Non-obvious design decisions: three deliberate divergences from the host `dsh-scope` — the filter lives on the actx (the host guards a business subject; client events carry only an id), keys compare by branded `SessionId` value rather than object identity, and the client scope is an *Agent identity* scope (the host Agent may be disposed while the client actx stays alive in view).
- Edge cases / failure handling: id→ctx handoff is allowed in only three kinds of place (slot inject factories, root coordination services self-addressing, root untagged listeners) — business providers never hand off. The "blank" bit is derived from absence of `turn/start`, not a header field.
- Surprising: a blank session's *successful first-prompt response* converts the `New Session` row in place — acceptance is display memory, not proof that a turn or user message reached durable history.

### .agents/notes/archived/architecture/2026-07-25-web-command-surfaces-and-assembly.md
- Purpose: The command directory cache, the three command kinds, popup selection, skill/subagent reference sources, and assembly-level acceptance.
- Key abstractions: `CommandUiRuntime` + a session-keyed `CommandDirectory` + a per-session `PopupSelectController`; `ClientSessionContext { sessionId }`; three command kinds — leadingInput, popupSelect, execute.
- Data flow: the directory is compartmented by `SessionId` with per-key single-flight and an epoch guard; `commands/changed` soft-invalidates (the old snapshot keeps serving while the repull runs), `connection/reset` hard-invalidates and rewarms, Enter strong-waits on the current key.
- Non-obvious design decisions: developers never declare positions — the kind is *derived* from the registration surface, and the dispatch table is explicit: the menu can trigger all three, Space recognizes only leadingInput (the misfire defense — irreversible side effects keep explicit entry points only), Enter runs execute or opens the shell only on a bare token.
- Edge cases / failure handling: the popup captures its projection at open, consumes the token only on success, retains it for retry on failure, and merely hides on a session switch; a failure keeps the draft with no downgrade.
- Surprising: skill and `@subagent` references are *plain text* outcomes riding ordinary prompts, with no RPC and no command-plane involvement — and `blank` rows are excluded from search entirely, because a bilingual display title cannot match a single-language query stably.

### .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md
- Purpose: The composer state machine, the three scoped bail events, and the `/`/`@` trigger pipeline.
- Key abstractions: `SubmitMachine` (pure, clock injected) with four phases; `PreStepDecision`-style `adjudicated`/`adjudication-failed`/`submit-settled` events; `InputTriggerService` + per-session `InputTriggerController`; `InputTriggerSource{trigger, name, order?, candidates, onPick, matchSpace?, matchEnter?}`.
- Data flow: the machine emits effects (`adjudicate`, `begin-submit`, `default-sink`, `commit-draft`, `notice`) that the shell executes; the three bail events (`slash/input-begin-command`, `slash/input-insert-reference`, `slash/input-consume-token`) are the only cross-plugin rewrite channel, and `true` is returned ⟺ a rewrite actually happened.
- Non-obvious design decisions: command mode is *never derived from the draft* — the pick paths establish it explicitly at discrete moments, and the claim is watched by `draft.startsWith(token)` with a backspace break releasing it automatically. `matchSpace` is synchronous (space fires mid-keystroke), `matchEnter` is asynchronous.
- Edge cases / failure handling: a `SubmitAttempt` (seq + AbortSignal) blocks stale-result backwash; on failure the enter-time snapshot is backfilled only while the live draft still equals it — if the user has typed again, only a notice fires.
- Surprising: one resident composer shell survives the no-session → blank → active flips; the same InputBar instance goes live, so the composer surface DOM never remounts (a `chain` election would unmount it and break that).

### .agents/notes/archived/architecture/2026-07-26-job-registry-seam.md
- Purpose: Splits the background-job registry into the standard Service Definition / Service Provider / Consumer trio.
- Key abstractions: `dsh-jobs` (abstract `JobRegistry` + the nine-method contract + vocabulary types), `dsh-jobs-local` (`LocalJobRegistry`: store, per-kind id counters, waiters, owner-cleanup effects, admission policy), `dsh-tool-jobs` (unchanged consumer).
- Data flow: the Service Definition's class-level JSDoc states the semantics every provider owes — registrations outlive producer and controller fibers, owned access is session-fenced, settlement is first-wins with contained listeners, and `start` refuses work while no attached controller serves the spec's owner.
- Non-obvious design decisions: composition-not-inheritance was rejected here in favour of the split: the Service Definition-only extraction inside one package "separates nothing operationally" because consumers still depend on the package carrying the provider.
- Edge cases / failure handling: `abstract` erases at runtime, so mounting the Service Definition package directly fails loudly at load with "load a Service Provider such as @deepseek-ai/dsh-jobs-local" instead of a half-registered `ctx.jobs` failing far from the misconfiguration.
- Surprising: producer misconfiguration diagnostics name `dsh-jobs` (the package declaring the absent service) while the Service Definition's own README points at Providers — so the message stays correct when another backend becomes the default.

### .agents/notes/archived/architecture/2026-07-26-packed-chunk-rows-by-default.md
- Purpose: Makes packed chunk rows the default JSONL storage layout.
- Key abstractions: `packChunkRuns()` and `decodeStorageRecord()` at the `dsh-session` storage seam; `packChunks` (omission resolves to `true`); the `text-chunks` / `reasoning-chunks` / `tool-call-chunks` storage rows.
- Data flow: the encoder recognizes exact delta-event shapes, preserves unrecognized events verbatim, and packs only runs of at least three; decoding reconstructs every original event, timestamp and sequence number. A packed row is *encoding vocabulary*, not a `SessionEventMap` member — it never enters the Session log or fires `session/event`.
- Non-obvious design decisions: reading is unconditional and layout-blind, so packed, unpacked and mixed files load into the same contiguous `SessionEvent[]` and no session-format version change or on-disk migration is needed. `packChunks` controls newly appended batches only; it never selects a reader mode.
- Edge cases / failure handling: `scripts/session-fixture-layout.snapshot.ts` discovers tracked and unignored-untracked `*.jsonl` fixtures repository-wide, selects those whose first record is a `session` header, and rejects content differing from `packChunkRuns()` output — the inventory includes ACP, headless, TUI, web, parent and child sessions with no maintained path list.
- Surprising: a *default* is only meaningful when the shipping compositions and the tests representing them share it — flipping only the backend schema default would leave wrapper defaults, serializers and fixtures inconsistent.

### .agents/notes/archived/architecture/2026-07-26-subprocess-seam.md
- Purpose: Extracts "run and manage a process" from the bash executor into its own capability family.
- Key abstractions: `dsh-subprocess` (abstract `SubprocessRuntime` + `DSH_ENV_PREFIX`/`DshEnvironment`/`CollectedOutput`), `dsh-subprocess-local` (`LocalSubprocessRuntime` over `spawn.ts` plus `node-pty`), `dsh-bash-local` (consumer), `dsh-shell` (re-exports the moved vocabulary).
- Data flow: each stdio stream independently selects `'pipe' | 'inherit' | {maxBytes, spill?}` and stdin selects `'ignore' | 'pipe' | {data}`; `argv` is never shell-interpreted; `terminate()` owns TERM→grace→KILL for the tree and `waitForExit()` observes tree liveness.
- Non-obvious design decisions: one stdio mode for all streams was rejected because real consumers mix modes per stream (LSP pipe/pipe/collect, ACP pipe/pipe/inherit, Bash data/collect/collect). Terminal presentation env (`TERM=dumb`, `PAGER=cat`) stays in the bash consumer, not the generic service.
- Edge cases / failure handling: the credential-shaped scrub (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`) is applied before explicit env, so a caller's own entry still wins; a background spawn failure can no longer be buffered as fake stderr, so the executor injects the note into exactly one `readOutput()` delta.
- Surprising: background-process lifetime moved from the executor to the service, so an executor reload leaves background work running — matching the job registry's lifetime model.

### .agents/notes/archived/architecture/2026-07-27-dispose-ladder-to-consumer.md
- Purpose: Moves the process teardown *policy* out of the subprocess Service Definition and into its one consumer.
- Key abstractions: `SubprocessHandle` keeps `kill`/`terminate`/`waitForExit` (mechanisms); `dsh-subagent-acp` owns `disposeAcpChild(child, eofGraceMs)` built entirely on those verbs.
- Data flow: close `stdin` → bound a `waitForExit` on `eofGraceMs` → `terminate()` (whose SIGTERM→grace→SIGKILL escalation owns the signal timer) → await an unbounded `waitForExit()` for whole-tree exit proof.
- Non-obvious design decisions: a Service Definition method every provider must implement is not a convenience, it is contract surface — and this one encoded one consumer's stdin-EOF-first cooperation shape as if it were process vocabulary.
- Edge cases / failure handling: the seam's own README already had to caveat that children quiescing on other signals need "their own tier-1" — that caveat was the admission that the ladder is policy.
- Surprising: the ladder's tier tests live in the ACP suite, and the Service Definition suite pins only the verbs the ladder composes.

### .agents/notes/archived/architecture/2026-07-27-tui-chat-channel-module-split.md
- Purpose: Splits a 2000-line TUI entry file into cohesive sub-machines.
- Key abstractions: `createModelController`, `createQuestionQueue`, `createResumeController`, zero-state `chat/helpers.ts`, and `ChatChannelDeps` + `ChannelNotice` in `chat/channel.ts`.
- Data flow: each controller is a factory taking an explicit dependency bundle; stable value collaborators (`ctx`, `resolved`, `palette`, `overlayManager`) are destructured once, while channel callbacks (`appendNotice`, `requestRender`, `isDisposed`, `agentStatus`) stay on `deps` so a controller always calls the channel's *current* implementation.
- Non-obvious design decisions: free functions taking a shared mutable context object were rejected — it would re-expose the same forty-field grab-bag "just under a parameter name". The status/timing animation controller stayed inline because a controller boundary there would leak internal state back through getters.
- Edge cases / failure handling: the model controller is a `let` forward-reference (the prompt caret animation closes over it) — one justified `prefer-const` disable and a deferred first paint.
- Surprising: `index.ts` only dropped from 2067 to ~1530 lines — the split is about readability per concern, not line count.

### .agents/notes/archived/architecture/2026-07-28-consolidated-tui-presentation.md
- Purpose: One terminal-reading model: palette, tool cards, context folding, cross-workspace resume.
- Key abstractions: `paletteSpec(scheme)` as the single table of SGR/close codes; `createPalette` deriving every wrapper; branded colors and attributes as separate types.
- Data flow: `/palette` prints the same table the running terminal uses; a tool card is one colored `Tool / <name>` status header over one dim body; `renderUnknownXml` receives an explicit body styler.
- Non-obvious design decisions: duplicate palette roles are merged (`muted`→`dim`, `added`→`success`, `removed`→`error`); `dim` uses `2;39` and closes with `22;39` on both schemes so recessed text stays relative to the terminal foreground rather than becoming a fixed heavy gray on light backgrounds.
- Edge cases / failure handling: folding uses the shared `preview` helper after body assembly, so it depends only on row count, never on parser success; injected context renders as prose with only *exact* matched outer `<system-reminder>` lines stripped — mismatched or inline tag-like text stays verbatim.
- Surprising: `Ctrl+O` cycles collapsed/expanded/hidden, and context cards fall back to collapsed while tools are hidden — injected instructions are not disposable tool traffic.

### .agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.md
- Purpose: A capability-discriminated directory-picker seam for the web GUI.
- Key abstractions: `capability()` returning a discriminated union `{kind:'native', pick(signal)} | {kind:'browse', list(path?), createDirectory(path,name)}`; `DirectoryPickerController`; a `single` directory-flow hole in two slot seats.
- Data flow: backend packages are *dual-face* — the browser half registers the matching interaction into both holes, so one `cordis.yml` row swaps the host capability and the client flow together and a mismatch is impossible by construction.
- Non-obvious design decisions: the seam is deliberately *not* on `ctx.fs` — riding the model/session storage stack would couple GUI browsing to the model's confinement backend, and swapping `fs-sandbox` must never change GUI behavior. The union is discriminated because the backends differ in *interaction shape*, which is irreducible.
- Edge cases / failure handling: listing is bounded and streamed (`maxEntries` default 1000, name-sorted window of `maxEntries + 1` candidates) so memory stays O(maxEntries); a wire `DirectoryListing` carries a required `truncated` flag so the client states incompleteness instead of silently missing tail entries; every await in a scan races the request signal.
- Surprising: the path editor's cancel scope is the *dialog card*, not the input — after Tab parks focus on a filtered row the input is off the event path, yet Escape must still collapse the editor; and "the pane arity is the invariant" — the last pane always lists the level the path names.

### .agents/notes/archived/architecture/2026-07-28-dsh-native-typescript-source-launch.md
- Purpose: A zero-build source launch for `dsh` using Node's native TypeScript transform.
- Key abstractions: `scripts/tspath-loader.ts` registering *only* a module resolve hook; `TsconfigPathsResolver` following the `extends` chain; `verify-cordis-config` as a one-way completeness check on the resolver manifest.
- Data flow: `node --experimental-transform-types` transforms; the loader maps workspace bare specifiers to `.ts`/`.mts`/`.cts` sources using the root tsconfig's `paths`; Node remains solely responsible for transformation.
- Non-obvious design decisions: source imports are redirected *only* when the target is the nearest manifest's own name or one of its declared runtime dependencies — applying the root `paths` unconditionally would allow undeclared cross-package imports and hide mismatches between the manifest and the actual runtime graph.
- Edge cases / failure handling: after the Loader settles, the shared app-boot checks every enabled entry that has no fiber and rejects startup listing all failed plugins — because the Loader logs import errors and leaves an entry without a fiber but does not fail startup itself (a typo produced an incomplete app with exit code 0).
- Surprising: vendored Cordis/Loader/Include/HMR/Schemastery must mark erased imports with `import type`, and Schemastery needs a native ESM default export plus `type: module` — the vendoring obligation is recorded in `vendor/README.md`.

### .agents/notes/archived/architecture/2026-07-28-user-settings-seam.md
- Purpose: A user-editable settings layer with a write path and hot propagation.
- Key abstractions: `dsh-settings` (abstract `SettingsProvider`: namespace registry, layered resolution, schema validation, per-namespace deep-equal change detection, the `settings/updated` event), `dsh-settings-file` (YAML/JSON under `resolveSpec`, chokidar watch, read-modify-write under a writer lock, atomic `0600` tmp+rename, leaf-level diff patching, content-equality self-write suppression).
- Data flow: three layers resolve in order — schema defaults, then the registrant's composition `base`, then the user document section. Registrations are caller-fiber effects: disposing the registrant removes the namespace and its watchers while the user's section keeps living in storage for the next owner.
- Non-obvious design decisions: "fail loud at rest, last-good in motion" — boot-time and registration-time validation throw, but once live a bad external edit warns and keeps the last good state per namespace, because a hot reload must never take the process down. The litmus test for what belongs in settings is "should the personal config page edit it?".
- Edge cases / failure handling: consumers stay optional by construction (`ctx.inject(['settings'], …)`), so every existing composition, demo and snapshot works unchanged and migration is per-plugin.
- Surprising: `fiber.update` (Loader-reactive config) cannot carry this — it swaps entry config in place, so a plugin that read config at construction observes nothing and no callback tells it otherwise.

### .agents/notes/archived/architecture/2026-07-29-package-regrouping.md
- Purpose: Regroups `packages/` by *measured* clustering rather than theme.
- Key abstractions: the north star "closely clustered packages share a group", where a cluster is measured by peer-dependency edges and co-change.
- Data flow: the new groups are `session/` (persistence + projection + title + telemetry, 11 packages), `interaction/` (question/approval/permission/commands/tui), `boot/`, `guard/`, `extensions/` — 42 groups became 39.
- Non-obvious design decisions: the grouping rationale is *measured*, so `session-query` stays standalone (it is an independently consumed read surface with its own tool package and SQLite FTS backend) and `web` ↔ `skill` stay apart because the graph shows zero edges between them. `core/session` (the live in-memory service) stays in `core/` while the new `session/` group is the durable family around it.
- Edge cases / failure handling: a group move touched tsconfig references, the aggregate and path maps, group READMEs, the packages README, the root AGENTS.md layout map, regenerated artifacts and the lockfile's importer keys; the moves landed as pure `git mv` so rename detection carries history. A fail-open test glob would silently drop coverage, so the group-scoped globs in `vitest.snapshot.config.ts` were rewritten with the moves.
- Surprising: `session-utils/` was rejected because it was a negatively-defined annex ("derived, nothing load-bearing depends on it") — the grab-bag shape the north star forbids — and factually wrong besides (`session-query` peer-depends on `dsh-session-title`).

### .agents/notes/archived/architecture/2026-07-29-request-level-llm-config-credentials.md
- Purpose: Makes LLM adapter configuration restart-free and moves secrets behind their own seam.
- Key abstractions: per-request options thunks plus a per-stream credential resolver; `ctx.credentials` (three-package seam: Service Definition / file-backed provider / consumer); `packages/util/atomic-write`.
- Data flow: the adapters resolve once per operation — two requests straddling a change see two configurations, one request resolves exactly once, and an in-flight stream keeps the facts it started with. Configuration carries `apiKeyEnv: DEEPSEEK_API_KEY`; the credential seam resolves that reference per operation.
- Non-obvious design decisions: per-request resolution replaces fiber rebuilds entirely, deleting the `DUPLICATE_ADAPTER` ordering, `NO_ADAPTER` windows and a deferred-activation state machine, and turns a missing key into a request-time `MISSING_CREDENTIAL` naming every entry point. Secrets are *references*, not values — the coding-agent cohort (Codex, Reasonix, OpenCode/Pi, Claude Code) unanimously keeps secrets out of config files.
- Edge cases / failure handling: the process environment layer is read-only and *wins* (a launch-time override is operator intent), and a shadowed write rejects rather than appearing to succeed; the provider-managed document is replaced wholesale on reload so a deleted entry never lingers.
- Surprising: the natural move — putting `apiKey` in the settings document — would have forced masking, server-side backfill on `replace` and dotfiles-sync warnings, "a mitigation stack for a problem peer products simply do not have".

### .agents/notes/archived/architecture/2026-07-30-adapter-owned-max-token-defaults.md
- Purpose: Makes the per-request output cap an adapter-configured default that stays reconstructable.
- Key abstractions: `LlmResolvedModelInfo.defaultMaxTokens`; `LlmRuntime` validating it as a positive safe integer; a "prepared call identifies materialized `maxTokens` and `reasoningEffort` fields as adapter defaults" marker.
- Data flow: the loop prepares calls before logging `request/header`, so the effective config and the "supplied by the adapter" markers become durable request facts before dispatch; before the next `agent/request` waterfall, marked fields are removed from the proposal and the current route's defaults are materialized again.
- Non-obvious design decisions: applying the default only in provider serialization was rejected because the wire request would then differ from the durable `request/header`. The marked-field removal is what stops a provider/model switch from mistaking the previous adapter's default for an explicit override.
- Edge cases / failure handling: explicit request or Agent options remain unmarked and therefore win without clamping; 256,000 is a *request budget*, not evidence that every endpoint rejects larger outputs.
- Surprising: the 256,000-token output budget reserves a large part of the one-million-token context on endpoints that pre-allocate requested output — a documented deployment hazard rather than a silent one.

### .agents/notes/archived/architecture/2026-07-30-client-locale-full-rollout.md
- Purpose: Moves all client copy onto a typed locale seat.
- Key abstractions: `SlotLabel = string | (() => string)` for registration-time text; the typed `t` seat; `LocaleId`; `ctx.locale.addLanguage({id,label,fallback})`; dictionary namespaces `zh`/`en`.
- Data flow: `resolveSlotLabel` resolves a label thunk per read and makes the read point follow the locale revision; off-ledger projections fold the revision into their cache key and subscribe to both sources.
- Non-obvious design decisions: a language switch causes *zero* ledger churn — no re-registration, versions stay put, and every `locale/change` re-registration wiring is deleted. The built-in language set is closed (`zh`, `en`) while the catalog is extensible; every added language names a registered fallback and the chain must terminate at `en`.
- Edge cases / failure handling: lookup walks the fallback chain in the requested namespace, then repeats it in `common`, before displaying the key itself; unknown targets and cycles fail at registration. An unavailable saved id stays pending until its language registers.
- Surprising: no `Intl` is used for dates — the dictionary holds the format templates, because `toLocaleString()` follows the browser/OS language and guarantees mixed text after a switch.

### .agents/notes/archived/architecture/2026-07-30-command-row-copy-contract.md
- Purpose: Stops the command row from saying the command name and its argument twice.
- Key abstractions: the row title is the bare command name; the handler's settlement `text` is the summary.
- Data flow: `command/run` (structured `name`/`args`) supplies the title; `command/done`'s verbatim `text` supplies the summary.
- Non-obvious design decisions: the rule bans the *label*, not the vocabulary — `Permission preset: workspace-write.` lost because the caption is already the title, but `/plan` keeps `Plan mode off.` and `/goal` keeps `Goal cleared.`, because a domain noun that happens to contain the command's name is not a caption.
- Edge cases / failure handling: `GenericCommandCard` keeps the `命令` fallback for a cross-window node whose `command/run` page fell out of the client's window.
- Surprising: the no-caption rule is "a convention the reviewer enforces, not a gate" — and the cost is that the dispatched arguments leave the collapsed row, so a running command shows only its name and `执行中…`.

### .agents/notes/archived/architecture/2026-07-30-config-plane-boundaries.md
- Purpose: Hardens who may read and overwrite the configuration plane.
- Key abstractions: `SettingsProvider.mutate(ns, ops)` with `set`/`unset` path ops; a monotonic per-namespace `revision`; `expectedRevision`; `settings/document-updated (ns, revision)`.
- Data flow: the client diffs its opening snapshot against its draft and emits ops naming only fields it can see, so a secret absent from both sides produces no op and survives by construction rather than by care.
- Non-obvious design decisions: reading configuration is as privileged as writing it — `settings.describe`, `credentials.describe` and the model catalog all require one browser session, asserted over a real HTTP server so a forged loopback `Host` never establishes identity. An unregistered and an unexposed namespace answer identically (`settings-not-exposed`) so probing cannot enumerate the registry.
- Edge cases / failure handling: a revision mismatch rejects with `settings-conflict`; the editor tells the user to reopen rather than replaying its snapshot. `settings/updated` stays gated on the *resolved* value (what a consumer means by change) while `settings/document-updated` fires on any raw-section change (a field going from inherited to overridden).
- Surprising: the redaction gaps are deliberately left for a fail-closed `describeForWire()` — `redactSecrets` walks only object/dict/array, so a secret behind a union or transform is returned verbatim today, and is recorded as `TODO(settings-wire-redaction)` rather than half-fixed.

### .agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.md
- Purpose: Marks where inherited history ended, so a plugin's open/close bracket is classifiable.
- Key abstractions: the log-only `session/end-seed` event; `Session.firstLiveSeq` (its in-memory twin); the `Session` constructor as the single waist.
- Data flow: the constructor appends `session/end-seed` immediately after an explicitly supplied seed (including an empty one), as the seeded session's first live write; it is part of the log `initFor` captures as the creation seed, so it never publishes on `session/event` and a consumer watching the firehose must read it from the log.
- Non-obvious design decisions: a bracket owner reads it *positionally* — an unmatched opening marker before `session/end-seed` has a smaller seq, came from the constructor seed, and belongs to a lifecycle that has ended. Core writes the boundary and reads nothing from it; each bracket's vocabulary stays with its owning plugin.
- Edge cases / failure handling: two guards keep the marker precise — an omitted seed writes nothing (the session is fresh), and a seed already ending in one is not re-marked, which makes the write idempotent (load-bearing, because each Agent-bound pickup of a cold session passes through `agentFor()`). A crash before the seed write loses the boundary, and costs nothing: the pending batch is written in order, so every event after it is lost too.
- Surprising: attaching is *not* a pure read — a pickup now writes where nothing was written before, so a read-only or full disk fails at `session/created` rather than at the first real turn.

### .agents/notes/archived/architecture/2026-07-30-settings-write-path-integrity.md
- Purpose: Makes the settings write path non-destructive and the observer lifecycle quiescent.
- Key abstractions: one settled operation chain shared by watcher refreshes and persists; a `wx`-created `<file>.lock` sibling; `cloneJsonShaped`; `renderYaml` leaf-level diffs; `pendingTails`.
- Data flow: `persistSection` begins by reconciling the on-disk text into the seam — publishing any unobserved difference first — before rendering against that fresh text, so a write can no longer resurrect a stale document.
- Non-obvious design decisions: the writer lock is hand-rolled rather than `proper-lockfile` (barely maintained, broader policy than this one-file protocol needs); readers never lock because the rename commit is atomic, so contention is writer-only. `EPERM` identifies contention only when `lstat` confirms the lock path exists, because Windows may report permission denial for an exclusive create against an existing path.
- Edge cases / failure handling: a contender times out *without* removing the existing lock, because age cannot distinguish a crashed owner from a paused live writer — orphan recovery is an operator action. The write boundary rejects Date/Map/BigInt/non-finite/function/symbol/class-instance/`undefined`-array-entry/circular values with a `$`-rooted path before anything persists.
- Surprising: YAML edits are leaf-level diffs, so comments, anchors and formatting survive on every untouched node — while arrays and other non-map values still replace wholesale and take their comments with them.

### .agents/notes/archived/architecture/2026-07-30-web-config-plane.md
- Purpose: The wire face and web UI for settings, credentials and provider topology.
- Key abstractions: `settings/describe|update|replace|mutate|openSettingsDocument|openAgentPresetDirectory` and `credentials/describe|set|unset`; `llm/listProviders|listConfigurableProviders|discoverModels`; `SettingsDescriptor` carrying `base`/`user` layers; `ctx.settingsSchema` (schemastery nodes rehydrated from the wire's `toJSON()` envelope).
- Data flow: `describe({redactSecrets: true})` strips `role('secret')` subtrees from all three layers and enumerates the stripped slots as `{path, set}`, so a page can render write-only inputs without ever receiving a value; a typed key is stored *write-only* through `credentials.set` under the profile's `apiKeyEnv`, so `settings.yaml` never carries a key value.
- Non-obvious design decisions: a generic schema-driven form renderer was implemented first and then *replaced* — field truth without visual hierarchy produced an unstyled schema dump, and making it good meant building a hint vocabulary rivaling a hand-written editor in cost. The protocol choices come from the namespace's own schema, so the offered choices cannot drift from the accepted ones.
- Edge cases / failure handling: a user-layer provider removal is a two-stage idempotent flow (a localized confirmation dialog, then removal of an exact configured+writable derived credential before the profile); a partial failure stays in the dialog for retry, and custom/environment/unidentified credential targets are left untouched.
- Surprising: the `deepseek` → `deepseek-official` route rename touched 239 files with no compatibility alias, because the pi-ai catalog legitimately owns `deepseek` as an aggregator entry.

### .agents/notes/archived/architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.md
- Purpose: Claims the input batch before one pre-step decision, ending the split of one step boundary across three hooks.
- Key abstractions: the package-internal `ReactLoopInbox`; `PreStepDecision = {kind:'reject'} | {kind:'enter'; messages: UserMessage[]}`; the durable inbox as two `UserMessage[]` lists addressed by `MessageId`; the `inbox` session projection.
- Data flow: before every proposed step the loop atomically claims all `next-step` messages and, at a turn boundary, one `next-turn` message; the claim records normalized `agent/inbox/spliced` pure deletions and emits `agent/inbox/claimed { message, turn }`, then hands the exclusive batch to the `agent/pre-step` waterfall with `{turn, step, signal}`.
- Non-obvious design decisions: the initial boundary commits `turn/start` *first*, so the claim and its single decision have durable turn ownership. There is no `agent/prompt-prepare`, `agent/prompt-submit` or `agent/step` extension point.
- Edge cases / failure handling: reject opens no step, leaves the claimed batch removed and closes the turn as blocked without any step events; empty entry, cancellation and failure before `step/start` likewise close a balanced no-step turn. A listener wrapping `next()` preserves downstream changes unless it intentionally replaces them, so all rewrites settle once in the final return value.
- Surprising: live events carry no placement, outcome or batch fields — the durable splice already owns those facts, so repeating them would create a second contract that can drift.

### .agents/notes/archived/architecture/2026-07-31-code-runtime-portable-identifier-seam.md
- Purpose: Moves the portable-identifier exclusion contract up to the code-runtime Service Definition.
- Key abstractions: `PORTABLE_RESERVED_WORDS` (ECMAScript ∪ Python reserved words), `RESERVED_BINDING_GLOBALS` (`console`, `__dsh_main__`, `__builtins__`, `__name__`, `__debug__`), `RESERVED_ERROR_MEMBERS`, `DUNDER_MEMBER`; the portable subset `[A-Za-z_][A-Za-z0-9_]*`.
- Data flow: every Service Provider imports the shared constants rather than re-declaring them, so a binding-namespace list valid on one backend is valid on all.
- Non-obvious design decisions: `__debug__` is included even though it is not a seeded slot, because it is a CPython compile-time constant that rejects assignment — the same portability split by a different mechanism. `lambda` is refused everywhere even though it is a legal JS parameter name.
- Edge cases / failure handling: a Python backend that seeds any additional module global MUST widen `RESERVED_BINDING_GLOBALS` in the same change — "a name the bootstrap seeds but the set omits is the portability split this contract exists to prevent".
- Surprising: the constants live in the Service Definition even though the worker is the only shipped backend, because the contract is language-agnostic and owned above any single language.

### .agents/notes/archived/architecture/2026-08-01-packaged-ripgrep-search.md
- Purpose: Runs glob/grep against the *packaged* ripgrep binary instead of a host install.
- Key abstractions: `@vscode/ripgrep` as an npm dependency whose optional platform packages ship the binary; `runRipgrep()` spawning `rgPath` with a plain argv vector prefixed by `--no-config`; `ctx.subprocess` as the execution seam.
- Data flow: `rgPath` resolves lazily at the first call (memoized per process) because a static import would turn a missing or corrupt platform package into a Loader-composition failure — the exact load-time failure mode the change removes.
- Non-obvious design decisions: there is no shell layer, so the shell-quoting boundary disappears from execution and the `singleQuote` helper and its shell-spawning tests are deleted with it. `--no-config` is prepended because a host `RIPGREP_CONFIG_PATH` (or an `rg.conf` beside the binary) can otherwise inject a `--pre` preprocessor that executes an arbitrary command for every matched file.
- Edge cases / failure handling: exit 0 is success with results, exit 1 is a successful empty search, anything else classifies into the `SEARCH_*` vocabulary; a lossy stdout read fails as `SEARCH_RAW_OUTPUT_OVERFLOW` with zero content returned. Timeout is the cooperative tool-call budget, and the subprocess seam's terminate escalation provides the hard kill.
- Surprising: making `rgPath` injectable was rejected — "the packaged binary is the deployment, so tests should exercise it" — and the integration suite's fixture dropped a filename Windows cannot represent.

### .agents/notes/archived/architecture/2026-08-03-per-session-agent-presets.md
- Purpose: Lets each session run a different agent composition, composed from a preset `cordis.yml`.
- Key abstractions: a preset = a directory holding one `agent.cordis.yml`; the agent factory's `setup(agentCtx)` mounting it as a Cordis `include` subtree plugged into that agent's scope; the host/agent two-plane split; `resolveSessionPreset`; the `agent-preset/selected` event.
- Data flow: entry contexts chain to the context a subtree was plugged into, so every registration inside the preset lands in that agent's layer and unwinds with the agent — no registry gains a tier and no running session is touched. Model routing stays out of presets because `installAgentLlmTarget` is already the per-agent seam.
- Non-obvious design decisions: mounting is per-session by default because the measured cost is ~3 ms and ~600 KB per session, so isolation is cheaper than any sharing scheme; a preset that genuinely owns an expensive singleton opts into sharing with Cordis's `isolate` vocabulary. The preset id is model-visible and must be logged, because it determines the tool set and prompt.
- Edge cases / failure handling: switching is allowed only while a session is blank — once a turn has run, that history was produced under the preset's tools, so `agentPreset.select` answers `agent-preset-locked`. A blank switch is unmount-then-mount (two compositions would register the same tool names into one layer), so it resolves the new preset before tearing anything down and restores the previous one when the new mount fails. A preset may not publish into the root service realm, because the second session mounting the same preset would collide.
- Surprising: "nothing disposes an agent" — measured growth is strictly linear (~1.31 MB per `standard` agent) and disposal reclaims essentially all of it, so the object graph does not leak; the *lifecycle* does, because the host discards the `AgentHandle` and has no eviction.

### .agents/notes/archived/architecture/2026-08-03-pi-ai-declared-provider-catalog.md
- Purpose: Turns a pi-ai route from a catalog lookup into a *declaration*.
- Key abstractions: `catalog.ts` (merging the installed catalog under the profile's own entries), `provider.ts` (building the route's `Provider`), `adapter.ts` (turning each resolution into an immutable snapshot of profiles + a `createModels()` collection); per-model `id`, `name`, `contextWindow`, `maxTokens`.
- Data flow: a profile's `models` list *replaces* the route's catalog and each entry defaults its unset fields from the installed model of the same id; a catalog route that keeps its catalog protocol reuses the installed provider with `getModels()` replaced, every other route is built by `createProvider()` over a narrow protocol table.
- Non-obvious design decisions: the protocol table is narrower than pi-ai's full API set *on purpose* — it holds only protocols a profile can completely describe with a key, an endpoint and headers, so Bedrock, Vertex, Azure and Codex are absent rather than offered as routes that cannot authenticate. Materialization spreads the installed entry rather than enumerating the result, because an enumerated rebuild silently drops every `Model` field the package does not model.
- Edge cases / failure handling: a configuration change builds a *new* collection and leaves the one in use alone, so a request that started under one configuration cannot finish under another — the seam's per-step freeze holds all the way down. `registerConfigurableProviders` returns a handle with `replace(entries)` so a refused candidate set leaves the previous entries serving.
- Surprising: a capability whose only level does nothing is reported unavailable — pi-ai reports a model with no reasoning metadata as supporting the single level `off`, which renders as a picker whose only control is a lie, so `reasoningInfo` omits the field entirely for those models.

### .agents/notes/archived/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.md
- Purpose: Splits the credential store from the user's environment layer.
- Key abstractions: `.credentials.yaml` (a strict YAML mapping of `CredentialRef` → non-empty string, no `version` field, no wrapper level) and `$DSH_HOME/.env` (the user's ordinary environment layer) under the Harness home; `loadLayeredEnv` in `dsh-app-boot`.
- Data flow: credential precedence is inherited environment (read-only per-run override) → managed document → project `.env` → user `.env`; the Harness home is resolved from the *inherited* environment before either file loads, so a project `.env` cannot redirect which user document is read.
- Non-obvious design decisions: because the managed document holds credentials and nothing else, every deviation is a *rejection* rather than a skipped entry — a silently ignored key would read as "the secret I stored has no effect". The document editor is a patch of the parsed YAML, so comments and untouched entries keep their formatting and any string value round-trips (multi-line included).
- Edge cases / failure handling: a malformed document fails loud at boot and at a write, and warns-and-keeps-the-last-good-snapshot on a live reload. The `0600` the provider writes is also *enforced* on what it reads: on POSIX a document with any group or other permission bit fails the launch before its contents are read; Windows has no mode to inspect, so the check is skipped rather than faked.
- Surprising: the cost of the split is that a key left in `$DSH_HOME/.env` is materialized into `process.env` and reaches subprocesses under the credential scrub — it remains a writable fallback, but a secret the harness should own and isolate belongs in the managed document, which is never materialized.

### .agents/notes/archived/architecture/2026-08-04-declaring-a-provider-from-the-models-page.md
- Purpose: Lets a person declare a provider from the Models page without editing YAML.
- Key abstractions: `ModelListEditor` (shared) and `CustomProviderCard` (create); `settings.mutate` setting a whole `providers.<route>` profile; `credentials.set` under the derived `<ROUTE>_API_KEY`; `protocolChoices` read from the namespace's own schema.
- Data flow: fetching asks about the endpoint **the form currently shows** (a base URL edited but unsaved, a key typed but unstored), so adding a provider is one pass instead of save-then-return; the reply opens a picker rather than being written.
- Non-obvious design decisions: the create is a *separate card* because the route id is being chosen — until it is chosen there is no `settingsPath` to address the editor with, and recomputing the path per keystroke would remount the card and discard the draft. Candidates already configured start unchecked, so adopting a selection never overwrites a capacity the user corrected.
- Edge cases / failure handling: a provider that cannot be interrogated is a detour, not a dead end — the adapter's own message appears beside rows that stay editable by hand. Clearing an optional field drops it rather than storing a value the schema would reject, and a capacity that is not a positive integer is not stored at all.
- Surprising: the Provider ID stays fixed because it is referenced from *outside* this namespace (`agent-default-model` stores a `provider` string, and every logged `request/header` already records one) and because the page writes keys but can never read one back — a rename would orphan the stored key.

### .agents/notes/archived/architecture/2026-08-04-draft-provider-endpoint-interrogation.md
- Purpose: Lets a user ask a draft endpoint what it serves, before it is configured.
- Key abstractions: `ctx.llm.registerModelDiscovery(settingsNs, discover)` / `ctx.llm.discoverModels(settingsNs, request)`; `LlmModelDiscoveryRequest` carrying the draft (`provider?`, `baseURL?`, `api?`, `apiKey?`, signal); `LlmDiscoveredModel` with every field but `id` optional.
- Data flow: the namespace is the key, not the provider route, because a provider being added has no route to name; a route the adapter already describes is answered from its own registry with *no network call at all*, and only a route it does not describe reaches an endpoint.
- Non-obvious design decisions: the reply is *candidates*, not a catalog — a surface adopting one still owes the capacities the adapter requires. A named configured route reads its stored credential and deployment-owned profile `headers` inside the Host, because the credential is write-only and the curated Models page does not edit headers.
- Edge cases / failure handling: the reply is read under a four-megabyte ceiling enforced on the bytes actually received — the endpoint is a URL the user typed, so a declared `content-length` is checked first as a courtesy but never trusted as the bound. A protocol without a documented listing contract answers `DISCOVERY_UNSUPPORTED` so the surface falls back to hand-entry rather than reporting guessed fields as an empty provider.
- Surprising: `llm.discoverModels` is the third and last payload on which a secret may ride, and it is never stored or echoed back — but it does ride the client's outgoing envelope, where a `subscribeEnvelopes()` observer can see it; redacting that tap is a configuration-plane-wide change, not this method's to make alone.

### .agents/notes/archived/architecture/2026-08-04-websocket-downlink-carrier.md
- Purpose: Moves the browser downlink off SSE so it stops consuming the HTTP/1.1 connection pool.
- Key abstractions: one independent WebSocket per downlink stream class (`/api/events.mux` → `MuxFrame`, `/api/events.host` → `HostFrame`); `WebApiClient` holding HTTP `fetch` for uplink and WebSocket for downlink; an exact upgrade-route registration point on `ctx.webServer`.
- Data flow: each text message is one complete `ServerRequest` JSON document; the client validates the envelope first, then the concrete frame union, and passes the narrow `RpcRequest<Frame>` to the existing `ConnectionController`.
- Non-obvious design decisions: WebSocket carries *only* the host→browser downlink; all client→host unary calls and `respond` operations stay on `POST /api/*`, so the uplink's timeout, cancellation, HTTP-status, trust-fence and request-correlation behaviour is untouched.
- Edge cases / failure handling: before upgrade the client applies the `/api` Host/Origin checks followed by the same signed browser-cookie authentication as unary HTTP — an untrusted authority gets 403, a trusted but unauthenticated request 401, and neither starts a Remote stream. A mid-stream host error sends one `stream/error` frame and closes; the client treats that as connection loss rather than delivering it to a business sink.
- Surprising: the in-process fetch carrier keeps SSE encoding to prove the channel-independent protocol's isomorphism, but network GETs to `/api/events.*` answer only *Upgrade Required* — there is deliberately no browser SSE fallback, because two carriers would let the production path silently fork.

### .agents/notes/archived/architecture/2026-08-05-large-session-jsonl-restore-pipeline.md
- Purpose: Makes restoring a large session an ownership-transfer pipeline instead of several whole-log copies.
- Key abstractions: `ZstdFrameDecoder` (one lifecycle for interchangeable synchronous implementations, reusing one native decoder context); `SessionLogScanner` (newline search with `Buffer.indexOf(0x0A)`); `Session.fromRestore` (restore-only admission path).
- Data flow: the compressed artifact stays the source buffer; each stage consumes the previous stage's output incrementally and the resulting event array is the only complete decoded representation.
- Non-obvious design decisions: after ~500 ms of accumulated frame work the async reader yields at the next frame boundary — a single frame remains an indivisible synchronous operation, and the deadline is not a hard wall-clock bound inside one frame. The scanner carries an incomplete record across decoder writes and copies only that fragment, because the private decoder may reuse its output buffer.
- Edge cases / failure handling: the scanner stops *retaining* events at the first unparsable row or sequence gap but keeps inspecting later records; a later `turn/end` proves the issue is in the committed region and rejects the log. Only a structurally torn final frame may contribute a recoverable suffix.
- Surprising: measured on a 61.8 MiB / 1.3 M-event profile, the pipeline cut scan time from ~598 ms to ~397 ms and peak RSS from ~1,494 MiB to ~1,060 MiB, and `Session.fromRestore` from ~605 ms to ~263 ms.

### .agents/notes/archived/architecture/2026-08-05-session-preparation.md
- Purpose: One unpublished `Session` ownership window shared by fresh creation and persisted resume.
- Key abstractions: `SessionPreparation` (a Session lifecycle object, not an Agent lifecycle one); `SessionStore.prepare()` / `prepare(id, {seed, meta, seedSource:'persistence'})`; the shared setup-and-publication pipeline.
- Data flow: the loop acquires the preparation, builds the private Agent context around `preparation.session`, awaits optional setup, publishes that exact Session and Agent, and disposes the preparation on every exit.
- Non-obvious design decisions: the preparation is one disposable ownership window, not a cache — disposal is synchronous and idempotent and publication accepts only the exact prepared Session. A fresh create never claims a persisted identity implicitly; persistence collisions still reject.
- Edge cases / failure handling: the note's original persistence-side prepared-Session cache (LRU, exclusive reservations, revision-checked reuse) was *superseded* by the handle-based seam — resume now pays one whole-log read, an accepted cost, because the write handle's single-writer ownership is the exclusion resume actually needs.
- Surprising: "activation of an Agent for history reads" was rejected because pagination would keep query-only Agents live and transfer cache retirement into the Agent lifecycle — so observation never creates an Agent.

### .agents/notes/archived/architecture/2026-08-05-slot-declaration-injection.md
- Purpose: Makes the declared slot itself the dependency for a contributing plugin.
- Key abstractions: `SlotRegistry.inject(name, callback)`; the declaration *epoch* (distinct from the slot's ordinary entry version); iterable effect results installed transactionally.
- Data flow: the callback runs immediately when the declaration exists, otherwise waits; injection remembers the active epoch, disposes its callback effect when that epoch ends, and reruns for a replacement declaration even when the final observed state is continuously declared.
- Non-obvious design decisions: both sides keep their natural ownership — the injection controller and every contribution run on the contributing plugin's caller `Context`, so disposing that plugin removes its wait and its entries; the declaring plugin's `Context` is never retained as a capability source.
- Edge cases / failure handling: an injection whose declaration already exists reports callback setup failures *synchronously*; a failure after a delayed declaration first unsubscribes and rolls back its collected effects, then reports the failure outside the slot notification flush so one registrant cannot starve other listeners.
- Surprising: the epoch exists because "collapse and redeclaration can batch into one continuously present final state while the old contributions have already been removed" — judging replacement from `spec(name) !== undefined` alone loses that boundary.

### .agents/notes/archived/architecture/2026-08-06-agent-event-payload-objects.md
- Purpose: Makes every agent-scoped event take exactly one payload object.
- Key abstractions: the payload carrying the subject (`agent`), the event's fields and the cancellation `signal`; `agentEvents(ctx, agent)` and the one-shot `emitAgentEvent` as the fused dispatchers; the retirement of `PreStepContext` and `RequestFailureContext`.
- Data flow: the twelve `agent/*` events, `agent-loop/config-start-failed` and `goal/changed` all dispatch a payload; `next` remains the last argument of waterfall/serial events.
- Non-obvious design decisions: dispatch is fused so the scope carrier key and the payload's `agent` cannot diverge — the injected subject wins even over a structurally acceptable payload that happens to carry an `agent` field.
- Edge cases / failure handling: `ReactLoopAgent` builds its dispatcher once in the constructor and routes every emit, serial and waterfall through it, so hot-path dispatches allocate nothing.
- Surprising: the intermediate design (hand-building the subject at each dispatch site) avoided per-dispatch allocation but let the scope key and the payload subject diverge — the fused dispatcher is the single injection point for every dispatch mode.

### .agents/notes/archived/architecture/2026-08-06-app-owned-command-line.md
- Purpose: Lets each app own its own command line through `ctx.cmdlineArgs`.
- Key abstractions: `@deepseek-ai/dsh-cmdline` providing `ctx.cmdlineArgs` (`get(): readonly string[]`) and `ctx.appExit`; `parseCmdline(ctx, program)`; the launcher's `passThroughOptions` + `allowUnknownOption` + `helpOption(false)`.
- Data flow: the launcher parses only `--profile`, `--patch` and the config dumps and hands everything after its own flags to the booted tree verbatim; the split is positional — the first unrecognised token starts the app's arguments.
- Non-obvious design decisions: rows read the app's values through *direct lazy config expressions* (`port: !!js ctx.webStartup.port ?? 3080`), so a flag beats the value written beside it and nothing is written back into any row. The Loader mounts the composition once and interpolates each row's `!!js` against the injection-ready plugin context immediately before activation.
- Edge cases / failure handling: `--help` leaves the provider's service absent, so dependent rows never activate and the app requests bounded exit; a live patch reload interpolates again against the still-active service, so a served port cannot be silently reset. A create-or-replace of the whole `config` drops its expressions — and with them the flag's precedence for that row.
- Surprising: `instanceof CommanderError` was rejected because an out-of-tree plugin brings its own commander copy, so the class identity differs and a printed `--help` was rethrown as a fatal load failure — Commander's control-flow errors are detected structurally instead.

### .agents/notes/archived/architecture/2026-08-06-subagent-list-identity-projection.md
- Purpose: Makes listing subagents cheap by moving identity off the log and into a registered projection unit.
- Key abstractions: the `subagent` projection unit (`SubagentIdentityProjection = {mode:'one-shot',label?,seq} | {mode:'continuable',label,seq}`); the three-rung compute-and-discard ladder; the `SubagentListEntry` row shape with its `corrupt` / `unsupported` / `unavailable` diagnostics.
- Data flow: `listChildren` asks `sessionQuery.listSessions()` for the canonical live-preferred corpus, pairs each id with a live Session when one exists, and retrieves mode/label through the ladder: live → `sessionProjections.snapshot` (zero log reads), unseeded cold → `sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0), …)`, seeded or miss → one body-bearing `sessionQuery.observeSession(id)` plus the registered unit's fold.
- Non-obvious design decisions: the projection system has *no failure channel* — a unit never throws; a corrupt payload folds exactly like a log with no descriptor at all, and how "computed to nothing" is presented is the consumer's business. Values are computed on read and discarded: no index, no cache of its own, no list-side write-back.
- Edge cases / failure handling: the cold path's *lifecycle witness* (version, id, createdAt, cwd, parentSession, isSeeded, delegationDepth, origin, agentPreset) ensures a session deleted and republished under the same id degrades to a `corrupt` row in the old parent's catalog, leaking nothing of the new owner's child. Per-child isolation is back: one child's failed cold read loses only that row.
- Surprising: the note records five *accepted* boundary deviations, including multiple descriptors now resolving to the last (the provider contract guarantees exactly one anyway) and an unknown parent now yielding an empty list instead of a not-found error.

### .agents/notes/archived/architecture/2026-08-06-web-markdown-incremental-ast-renderer.md
- Purpose: Replaces the string-only markdown pipeline with an incremental mdast renderer.
- Key abstractions: `parseGfm` / `parseGfmWithMath`; `IncrementalMarkdownParser`; a direct mdast→React switch in `render.tsx`; KaTeX HTML mapped to React through the browser's own `DOMParser`.
- Data flow: the parser keeps the trailing two blocks unstable (the last is the frontier, the second-to-last is safety margin), freezes everything before them and re-parses only the source tail from the last frozen block's `position.end.offset` — the parser's own offsets, no bespoke source scanning.
- Non-obvious design decisions: each source region parses O(1) times per stream instead of once per chunk; a single giant block (an unclosed fence) degrades to the old full-reparse cost and no worse. Frozen blocks cache their React elements and keep source-offset keys, so crossing the freeze boundary reconciles instead of remounting.
- Edge cases / failure handling: the DOM is pinned by fixtures recorded from the *previous* react-markdown implementation, so a fixture diff is a user-visible style change to review, never to re-record for a refactor. Two deviations are named and both are healed by the settled full parse at finalize (a reference link or footnote whose definition lands across a freeze boundary renders literally while streaming).
- Surprising: this reverses an earlier note's rejected alternative ("maintain a custom React walker") — the incremental requirement was new evidence, and the walker's security-sensitive branches were already product-owned functions.


### (translation and pairing-record files)

The remaining 174 files are the Chinese translation of each English note and the bilingual-pair hash record beside it. The translations are verified structurally (same number and order of `##` headings, translated title, same position of the Problem section) and one was read in full; the hash records are six-line files naming the two git blob hashes of the English and Chinese sides plus the command that re-records them. Their per-file entries below are therefore one line each.

### .agents/notes/archived/architecture/2026-06-11-content-block-vocabulary.zh.md
- Chinese translation of the sibling English note `2026-06-11-content-block-vocabulary`: title '由 dsh-llm 拥有的提供方无关内容块词汇'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-content-block-vocabulary.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-content-block-vocabulary`: English blob `ae60931f37b3c470d0a1d6ee5f074ee77f9b3c14`, Chinese blob `3feed6e3ac9e7836a6e36be47fb19f346978886c`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-11-custom-schema-dsl.zh.md
- Chinese translation of the sibling English note `2026-06-11-custom-schema-dsl`: title '使用自定义类型化工具 schema DSL 替代 schemastery'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-custom-schema-dsl.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-custom-schema-dsl`: English blob `e09fea6c4bb80e287b1b64471eee4c87f24fba4a`, Chinese blob `2bacbde02838ef61b05f38796bbeeea262fc2d23`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-11-microkernel-event-taxonomy.zh.md
- Chinese translation of the sibling English note `2026-06-11-microkernel-event-taxonomy`: title '微内核——通过 Cordis 事件分类体系实现扩展，唯一具体循环'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-microkernel-event-taxonomy.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-microkernel-event-taxonomy`: English blob `681ab6eed1dc4d8a361990e69f071b918ce297c2`, Chinese blob `3b7504a21be7d83969c9cee77a77c33803a41e74`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-11-runtime-arg-validation.zh.md
- Chinese translation of the sibling English note `2026-06-11-runtime-arg-validation`: title '模型边界处的运行时参数校验'; 3 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-runtime-arg-validation.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-runtime-arg-validation`: English blob `22283c76719a26f733a8125bf263810d53a92c3c`, Chinese blob `f748b7e01b233edb8b3303898cc339dfacd16967`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-11-structured-error-taxonomy.zh.md
- Chinese translation of the sibling English note `2026-06-11-structured-error-taxonomy`: title '结构化错误分类体系'; 3 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-structured-error-taxonomy.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-structured-error-taxonomy`: English blob `a5c1c6e6120eefd3bc96090cfa4536fb83afa796`, Chinese blob `54a937c5595aa5645e4cc0f66a6d1a2efc232588`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-11-tool-schemas-in-prompt-assembly.zh.md
- Chinese translation of the sibling English note `2026-06-11-tool-schemas-in-prompt-assembly`: title '工具 schema 是系统提示词组装的一部分'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-11-tool-schemas-in-prompt-assembly.i18n.yaml
- Bilingual-pair consistency record for `2026-06-11-tool-schemas-in-prompt-assembly`: English blob `4d5251163969127ad9fd8ed0c64416057713dfa8`, Chinese blob `c04246baa196f50ec1c0dc6f91e9b7b12f67c5e0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-14-session-persistence.zh.md
- Chinese translation of the sibling English note `2026-06-14-session-persistence`: title '会话持久化作为基于现有 `SessionEvent` 的抽象服务'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-14-session-persistence.i18n.yaml
- Bilingual-pair consistency record for `2026-06-14-session-persistence`: English blob `4d067d2905d764a5c0d70b0a3eae5de68cb717f4`, Chinese blob `1f0f4af301a439c02fc23a1ffdc541d6bcbb24d2`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-15-turn-enclosure-invariant.zh.md
- Chinese translation of the sibling English note `2026-06-15-turn-enclosure-invariant`: title '每个会话事件都封闭在一个轮次内'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-15-turn-enclosure-invariant.i18n.yaml
- Bilingual-pair consistency record for `2026-06-15-turn-enclosure-invariant`: English blob `f38f5b2600b57ad8f5fc4c8975579e281b5f3a49`, Chinese blob `b74ddf3f6b65a7990329a8a903aafe2e4ca41c90`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-17-filesystem-capability-seam.zh.md
- Chinese translation of the sibling English note `2026-06-17-filesystem-capability-seam`: title '文件系统能力 seam——ctx.fs、本地后端与面向模型的文件系统工具'; 8 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-17-filesystem-capability-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-06-17-filesystem-capability-seam`: English blob `a0c898c1d127a7828037b3a59d04ff73c82e31ba`, Chinese blob `0442333a0a7cbc4fcae0f4b02db1700ce6aafc9e`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md
- Chinese translation of the sibling English note `2026-06-18-agent-lifecycle-and-ownership-contracts`: title 'Agent 生命周期与所有权约定'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-18-agent-lifecycle-and-ownership-contracts.i18n.yaml
- Bilingual-pair consistency record for `2026-06-18-agent-lifecycle-and-ownership-contracts`: English blob `012346d9e5b8bf4fd661423b3c398e93e513659d`, Chinese blob `4f8aaac32dfa3d84a449f12441c23371f1a3a27d`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-18-shared-persistence-write-coordinator.zh.md
- Chinese translation of the sibling English note `2026-06-18-shared-persistence-write-coordinator`: title '共享持久化写入协调器'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-18-shared-persistence-write-coordinator.i18n.yaml
- Bilingual-pair consistency record for `2026-06-18-shared-persistence-write-coordinator`: English blob `5c324f2c0c2b951f664bcf92725a36c4975fd3a1`, Chinese blob `51ef76189cb9276214bf05bbd1dbd8e3755daa35`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-20-branded-ids.zh.md
- Chinese translation of the sibling English note `2026-06-20-branded-ids`: title '在所有应有之处使用 branded ID'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-20-branded-ids.i18n.yaml
- Bilingual-pair consistency record for `2026-06-20-branded-ids`: English blob `3078ebc7035c8c5a86c7a743a0452b0ebddf6c7d`, Chinese blob `3a7d7c319c9fc14724af306b8c601afa759a18e7`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-20-extract-example-app-packages.zh.md
- Chinese translation of the sibling English note `2026-06-20-extract-example-app-packages`: title '将示例应用提取为独立包'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-20-extract-example-app-packages.i18n.yaml
- Bilingual-pair consistency record for `2026-06-20-extract-example-app-packages`: English blob `06466aa575a535afe0ba614fb2c2c5b3e857aeab`, Chinese blob `ccd8eae1524210d75770248566810423280df3b0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md
- Chinese translation of the sibling English note `2026-06-20-generic-long-running-tool-runtime`: title '后台任务运行时（`ctx.jobs`）与通用任务控制工具'; 11 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-20-generic-long-running-tool-runtime.i18n.yaml
- Bilingual-pair consistency record for `2026-06-20-generic-long-running-tool-runtime`: English blob `7cdb72ece6ca5681ba83999dd5d95fc2c27bf318`, Chinese blob `bf0a5d61c0e45aa6b39c6bcd0ac71cfb9b61d43f`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-20-package-hierarchy.zh.md
- Chinese translation of the sibling English note `2026-06-20-package-hierarchy`: title '将包重组为模块化层级结构'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-20-package-hierarchy.i18n.yaml
- Bilingual-pair consistency record for `2026-06-20-package-hierarchy`: English blob `43435279cdf4eec544638a5b36c53b4833b4cbbd`, Chinese blob `a44304d071d165cfe8f112e987160dd37626a58a`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-21-mandatory-app-attribution-headers.zh.md
- Chinese translation of the sibling English note `2026-06-21-mandatory-app-attribution-headers`: title '对提供方请求强制携带 `User-Agent` 归属标识'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-21-mandatory-app-attribution-headers.i18n.yaml
- Bilingual-pair consistency record for `2026-06-21-mandatory-app-attribution-headers`: English blob `680bd56301d80f87f13294bc7744a5de376425be`, Chinese blob `d9e19dbf8cf5a8f8594f25c0cd8565a7deb4b8a6`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-26-file-context-as-event-gate.zh.md
- Chinese translation of the sibling English note `2026-06-26-file-context-as-event-gate`: title '将 `dsh-fs-observation-policy` 改为事件门禁插件，而非方法接口'; 12 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-26-file-context-as-event-gate.i18n.yaml
- Bilingual-pair consistency record for `2026-06-26-file-context-as-event-gate`: English blob `96962f6a7260cc4da393a90349528aece3c23ce1`, Chinese blob `22fb85fc1246bb67bc0793f8cf7816b6134f11ae`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.zh.md
- Chinese translation of the sibling English note `2026-06-30-bash-stdin-env-trusted-plugin-api`: title '在 bash seam 上支持 stdin 与额外 env'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-06-30-bash-stdin-env-trusted-plugin-api.i18n.yaml
- Bilingual-pair consistency record for `2026-06-30-bash-stdin-env-trusted-plugin-api`: English blob `b9883c88d091e6e932da7c65b8b7fe4d107c0fa4`, Chinese blob `884b83de21243e27fa39f7840adfffebc398a9b0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-02-fs-per-session-cwd.zh.md
- Chinese translation of the sibling English note `2026-07-02-fs-per-session-cwd`: title '相对文件系统路径按调用方的会话 cwd 解析'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-02-fs-per-session-cwd.i18n.yaml
- Bilingual-pair consistency record for `2026-07-02-fs-per-session-cwd`: English blob `81dafda9ba71bd2746926e8baa0f4eaf76748429`, Chinese blob `aa05ed41615f29d580595a66d4743d4baf02b1a9`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-02-result-time-applied-hunk-diffs.zh.md
- Chinese translation of the sibling English note `2026-07-02-result-time-applied-hunk-diffs`: title '结果时刻的 applied-hunk diff 用于文件变更'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-02-result-time-applied-hunk-diffs.i18n.yaml
- Bilingual-pair consistency record for `2026-07-02-result-time-applied-hunk-diffs`: English blob `19b41cc441f5cab299dbeded0a9eae25ab7e9f97`, Chinese blob `b77ec75f0f8af615bde3b95d8fb4620fddedbc9c`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-03-filesystem-directory-listing-seam.zh.md
- Chinese translation of the sibling English note `2026-07-03-filesystem-directory-listing-seam`: title '为文件系统 seam 添加直接目录列举能力'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-03-filesystem-directory-listing-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-03-filesystem-directory-listing-seam`: English blob `eb2650daf567d4bd98ed8553a4b743f5a01d945c`, Chinese blob `4bcda9f093f22c06348d4c69c4de3bd62f216f8e`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-05-subagent-provider-lifecycle-events.zh.md
- Chinese translation of the sibling English note `2026-07-05-subagent-provider-lifecycle-events`: title 'Subagent 提供方生命周期事件——`subagent/provider-added` / `subagent/provider-removed`'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-05-subagent-provider-lifecycle-events.i18n.yaml
- Bilingual-pair consistency record for `2026-07-05-subagent-provider-lifecycle-events`: English blob `a15c3e6faee993902547174fe9ea235d07d9ec2f`, Chinese blob `49e55a3b148775ed7e676b5f55058ef1427a86c6`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-05-windows-fs-permissions.zh.md
- Chinese translation of the sibling English note `2026-07-05-windows-fs-permissions`: title 'Windows 写入权限语义：继承 DACL，而非权限模式位'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-05-windows-fs-permissions.i18n.yaml
- Bilingual-pair consistency record for `2026-07-05-windows-fs-permissions`: English blob `da3aabd872156d04e27b8b5521486e1190ac1173`, Chinese blob `8cb3e90922894f1755e8861411a36463d1ec7367`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-05-windows-jsonl-durable-publish.zh.md
- Chinese translation of the sibling English note `2026-07-05-windows-jsonl-durable-publish`: title 'Windows 原生持久 JSONL 发布'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-05-windows-jsonl-durable-publish.i18n.yaml
- Bilingual-pair consistency record for `2026-07-05-windows-jsonl-durable-publish`: English blob `f6be0b602d00daabdffc152508b0f8658fcb47a5`, Chinese blob `136b4c92b44d53c6fbfcefc94b683c9cbbfc9597`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-06-tool-result-retention-library.zh.md
- Chinese translation of the sibling English note `2026-07-06-tool-result-retention-library`: title '工具结果保留库'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-06-tool-result-retention-library.i18n.yaml
- Bilingual-pair consistency record for `2026-07-06-tool-result-retention-library`: English blob `5ac8547036ed0b45ec6e55e6fb213a98b7c3df8f`, Chinese blob `b18fdd60f529f9e6df6b8fc7e3c90f9a39e65fc8`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-08-agent-scope-contexts.zh.md
- Chinese translation of the sibling English note `2026-07-08-agent-scope-contexts`: title 'agent 即注册作用域'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-08-agent-scope-contexts.i18n.yaml
- Bilingual-pair consistency record for `2026-07-08-agent-scope-contexts`: English blob `e6513e6dc5aab699ba12d028aa7985f8dc5e33af`, Chinese blob `bfb1dfdad882c51ea39fd701e5a6c549af9b2349`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md
- Chinese translation of the sibling English note `2026-07-10-after-call-compaction-pressure-and-overflow-recovery`: title '调用后压缩压力与上下文溢出恢复'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.i18n.yaml
- Bilingual-pair consistency record for `2026-07-10-after-call-compaction-pressure-and-overflow-recovery`: English blob `f5b739b80022c85c9009a37de0e8b3f147f920b1`, Chinese blob `303f266079e0738ed9b0c6d7a19fadce7dc77442`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-12-agent-scope-runtime-design.zh.md
- Chinese translation of the sibling English note `2026-07-12-agent-scope-runtime-design`: title 'Agent 作用域运行时设计与正确性'; 13 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-12-agent-scope-runtime-design.i18n.yaml
- Bilingual-pair consistency record for `2026-07-12-agent-scope-runtime-design`: English blob `dba700b99a622a2f38c964fcfe6a6fdcf877c45e`, Chinese blob `f5c12fce6b9829e4ada61eab44d49232fa5aa241`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-12-scoped-layers-store.zh.md
- Chinese translation of the sibling English note `2026-07-12-scoped-layers-store`: title '共享作用域分层存储'; 8 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-12-scoped-layers-store.i18n.yaml
- Bilingual-pair consistency record for `2026-07-12-scoped-layers-store`: English blob `d3060696ef54c8d06cd0724179dec49682c721e1`, Chinese blob `f5482a5a76724128fb445fbd7c21a2f61b8634c1`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.zh.md
- Chinese translation of the sibling English note `2026-07-15-llm-model-catalog-and-acp-selection`: title '建议性 LLM 目录与 ACP 会话级模型选择'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-15-llm-model-catalog-and-acp-selection.i18n.yaml
- Bilingual-pair consistency record for `2026-07-15-llm-model-catalog-and-acp-selection`: English blob `c5f6644d4746a8a962e7ab843493fda3862a8c0a`, Chinese blob `539f2f9a2f9d3d7b48b3ecabca4b401e32c5702c`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-15-lsp-capability-seam.zh.md
- Chinese translation of the sibling English note `2026-07-15-lsp-capability-seam`: title 'LSP 能力 seam 与面向模型的查询工具'; 11 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-15-lsp-capability-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-15-lsp-capability-seam`: English blob `3cce6eb3c7d8afef53aa675440c7eea1e990721d`, Chinese blob `c424a794a6662a655565dde6337c49543c5a8085`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-15-replay-token-meter-service.zh.md
- Chinese translation of the sibling English note `2026-07-15-replay-token-meter-service`: title '回放式 token 计量服务'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-15-replay-token-meter-service.i18n.yaml
- Bilingual-pair consistency record for `2026-07-15-replay-token-meter-service`: English blob `1e6832f1bd049a9568b3af3b925211f0665de288`, Chinese blob `6d00d5e1511aa66818689ccec7d4b023c291f9aa`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.zh.md
- Chinese translation of the sibling English note `2026-07-16-explicit-turn-cancellation`: title '显式轮次取消能力'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.i18n.yaml
- Bilingual-pair consistency record for `2026-07-16-explicit-turn-cancellation`: English blob `23aaaae2d1f57a546ccbae7986c163e50f89fe24`, Chinese blob `4ce379c84640a214be1fa9708426e15ecc25c1d4`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-17-local-spill-startup-cleanup.zh.md
- Chinese translation of the sibling English note `2026-07-17-local-spill-startup-cleanup`: title '本地 spill 文件的一次性启动清理'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-17-local-spill-startup-cleanup.i18n.yaml
- Bilingual-pair consistency record for `2026-07-17-local-spill-startup-cleanup`: English blob `c9567cab8b1193b9ea6dbc0ad3fae2bc18af9656`, Chinese blob `97f6d641ab7e09da401c5632804f6e27ad78d850`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.zh.md
- Chinese translation of the sibling English note `2026-07-19-gui-layering-and-rpc-protocol`: title 'GUI 分层与 RPC 协议——host/client 按能力提供方分层、四象限消息模型与 fetch 载体'; 9 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.i18n.yaml
- Bilingual-pair consistency record for `2026-07-19-gui-layering-and-rpc-protocol`: English blob `b27d8d024612d890819bfca9b43c0c81464dfdd3`, Chinese blob `3cf4ba6421c7332c1f8cebb61656a1546f3ad45f`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.zh.md
- Chinese translation of the sibling English note `2026-07-19-gui-web-client-architecture`: title 'Web 客户端架构——client cordis 插件树、slot 体系与 React-free 对象层'; 11 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.i18n.yaml
- Bilingual-pair consistency record for `2026-07-19-gui-web-client-architecture`: English blob `f54f13869d748b68fd00bdfff23c2da49b8fdc81`, Chinese blob `4ab3639dac9d7e8916a0d3affb14bd965c11d783`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-19-package-invariant-runtime-contracts.zh.md
- Chinese translation of the sibling English note `2026-07-19-package-invariant-runtime-contracts`: title '有意义的包不变量约定'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-19-package-invariant-runtime-contracts.i18n.yaml
- Bilingual-pair consistency record for `2026-07-19-package-invariant-runtime-contracts`: English blob `d0559b0379ce05aa9a5a0c30df4808e3088c840b`, Chinese blob `0cfe61ee6344a4f6da73ffff22bb8a1b30f9f3a9`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-19-package-owned-invariant-service.zh.md
- Chinese translation of the sibling English note `2026-07-19-package-owned-invariant-service`: title '包拥有的不变式服务约定'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-19-package-owned-invariant-service.i18n.yaml
- Bilingual-pair consistency record for `2026-07-19-package-owned-invariant-service`: English blob `6ebdd0edbe04766280fb9aae7067ba861b2ce010`, Chinese blob `dde72faed7249d64b939aaca1bc5d452eeed7bde`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-19-zstandard-jsonl-session-logs.zh.md
- Chinese translation of the sibling English note `2026-07-19-zstandard-jsonl-session-logs`: title 'Zstandard JSONL 会话日志'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-19-zstandard-jsonl-session-logs.i18n.yaml
- Bilingual-pair consistency record for `2026-07-19-zstandard-jsonl-session-logs`: English blob `8ab55279bc94224b8b048c972bfda5c4a91a2fc8`, Chinese blob `c8f1b1599c415aaec37af3f238a2a979461f855b`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-20-canonical-tool-output-contract.zh.md
- Chinese translation of the sibling English note `2026-07-20-canonical-tool-output-contract`: title '规范工具输出约定'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-20-canonical-tool-output-contract.i18n.yaml
- Bilingual-pair consistency record for `2026-07-20-canonical-tool-output-contract`: English blob `1e2cdacdfa9100ca89840bb6ff0c98f07cecf8be`, Chinese blob `6fa16a682a03a79d98278e2ffa543ec330550b9b`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-20-todo-event-ownership.zh.md
- Chinese translation of the sibling English note `2026-07-20-todo-event-ownership`: title 'todo 事件类型归其生产方所有'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-20-todo-event-ownership.i18n.yaml
- Bilingual-pair consistency record for `2026-07-20-todo-event-ownership`: English blob `3dfcd604393d05265eb895fa50647338830bd38f`, Chinese blob `8dabf8f0cde4ad8af325b00eb1be9d7b7011233f`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-20-unified-json-value-schema-dsl.zh.md
- Chinese translation of the sibling English note `2026-07-20-unified-json-value-schema-dsl`: title '统一 JSON 值 schema DSL'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-20-unified-json-value-schema-dsl.i18n.yaml
- Bilingual-pair consistency record for `2026-07-20-unified-json-value-schema-dsl`: English blob `c1cc5c16f3d0e8ac65cff881a9f7b2ff51259e2a`, Chinese blob `7cd7be62c47ba96914c802b208fd87640849b3eb`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-22-tui-interactive-extension-service.zh.md
- Chinese translation of the sibling English note `2026-07-22-tui-interactive-extension-service`: title '由 effect 持有的 TUI 交互扩展'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-22-tui-interactive-extension-service.i18n.yaml
- Bilingual-pair consistency record for `2026-07-22-tui-interactive-extension-service`: English blob `e523361ceb920d2848369d7d3cf1093765d296d4`, Chinese blob `23c46f6bc18d576912aaa648b26877873ea60eda`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.zh.md
- Chinese translation of the sibling English note `2026-07-22-unified-send-and-coalesced-user-messages`: title '将 agent 投递统一到 send(target × wakeup) 并把注入的上下文合并进 user/message'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.i18n.yaml
- Bilingual-pair consistency record for `2026-07-22-unified-send-and-coalesced-user-messages`: English blob `d2e39f4efd122d9e0dbb45a082779afa2ff42941`, Chinese blob `37c43fcb7bfa81b177e8ed00876e913e3ddf6ad6`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-23-toolview-dissolution.zh.md
- Chinese translation of the sibling English note `2026-07-23-toolview-dissolution`: title 'toolview 溶解——工具行即 per-view keyed slot'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-23-toolview-dissolution.i18n.yaml
- Bilingual-pair consistency record for `2026-07-23-toolview-dissolution`: English blob `d84255f697886556a46c0511aa89f2c4bfd886d8`, Chinese blob `9ae339361193a9b97f7bba44904af0c01e7f3fa0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-23-unified-session-query-service.zh.md
- Chinese translation of the sibling English note `2026-07-23-unified-session-query-service`: title '统一会话查询服务'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-23-unified-session-query-service.i18n.yaml
- Bilingual-pair consistency record for `2026-07-23-unified-session-query-service`: English blob `f69836f60dfd73f9d8490687294b8407e53e9b32`, Chinese blob `bf25f4337dc8696ae54ffb16a7dd74437d45858b`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.zh.md
- Chinese translation of the sibling English note `2026-07-24-adapter-owned-reasoning-effort-capabilities`: title '适配器持有的推理强度能力'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.i18n.yaml
- Bilingual-pair consistency record for `2026-07-24-adapter-owned-reasoning-effort-capabilities`: English blob `f5c240145dc7f405f8bc1f66b6b5f7f68991eb80`, Chinese blob `81994d4908bd9531cc7db35634bf768372ace1d7`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-24-dsh-commander-argument-adapter.zh.md
- Chinese translation of the sibling English note `2026-07-24-dsh-commander-argument-adapter`: title '通过单个 Commander 适配器解析 `dsh` 的 argv'; 8 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-24-dsh-commander-argument-adapter.i18n.yaml
- Bilingual-pair consistency record for `2026-07-24-dsh-commander-argument-adapter`: English blob `a5f6e580b91c0de1cdb433e1973bdff960384f06`, Chinese blob `4321ab154996c9b23ce58175b112234c92013cb8`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-24-project-session-directories.zh.md
- Chinese translation of the sibling English note `2026-07-24-project-session-directories`: title '按项目分组的会话目录'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-24-project-session-directories.i18n.yaml
- Bilingual-pair consistency record for `2026-07-24-project-session-directories`: English blob `92a8ea11b8150b7c60fe76ae1354c5fadddd13c9`, Chinese blob `1850f04366deb79709b2bc51db194098eab9a95e`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md
- Chinese translation of the sibling English note `2026-07-24-web-config-tree-boot-and-transport-layering`: title 'dsh web 的 config-tree boot 与 web 传输分层'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.i18n.yaml
- Bilingual-pair consistency record for `2026-07-24-web-config-tree-boot-and-transport-layering`: English blob `7f1a619796158be987e58fa718af119421e477fa`, Chinese blob `6f0dc590944f3994752ef1de06de46a843fdbc94`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md
- Chinese translation of the sibling English note `2026-07-25-web-client-session-scope-and-provide-channel`: title 'Web client Agent-scope 对等模型与供数通道（agents/scope / blank 复用 / provide）'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-25-web-client-session-scope-and-provide-channel.i18n.yaml
- Bilingual-pair consistency record for `2026-07-25-web-client-session-scope-and-provide-channel`: English blob `9afd2419c24f21b903c6e2c692cc6ee943244e07`, Chinese blob `2385cfc8edde2dd65291037ea6d0d18c90f720d4`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-25-web-command-surfaces-and-assembly.zh.md
- Chinese translation of the sibling English note `2026-07-25-web-command-surfaces-and-assembly`: title 'Web 命令业务面与装配（ui-commands / ui-skill / ui-subagent）'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-25-web-command-surfaces-and-assembly.i18n.yaml
- Bilingual-pair consistency record for `2026-07-25-web-command-surfaces-and-assembly`: English blob `bfb7d2697a979efc8101581d42f4ab223d1b1e97`, Chinese blob `d81f70403d22efb2203bbe221a45035fc3d6503f`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.zh.md
- Chinese translation of the sibling English note `2026-07-25-web-input-machine-and-slash-pipeline`: title 'Web 输入状态机、composer slot 与 slash 流水线（ui-conversation input / ui-input-trigger）'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-25-web-input-machine-and-slash-pipeline.i18n.yaml
- Bilingual-pair consistency record for `2026-07-25-web-input-machine-and-slash-pipeline`: English blob `b6d485d495717770ebb5148880b3c8c1cb23b948`, Chinese blob `69ed9a40f4dd9a316f147e3077c9167e1ee46eeb`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-26-job-registry-seam.zh.md
- Chinese translation of the sibling English note `2026-07-26-job-registry-seam`: title '任务注册表是一个能力 seam（`dsh-jobs` / `dsh-jobs-local`）'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-26-job-registry-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-26-job-registry-seam`: English blob `d1a8cfb7bc4f1a8e313dfa8d59a5d0e5f8106190`, Chinese blob `1624a410407d8e6ac8cc85a6fe1480e0867eef6d`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-26-packed-chunk-rows-by-default.zh.md
- Chinese translation of the sibling English note `2026-07-26-packed-chunk-rows-by-default`: title '将打包分片行设为默认 JSONL 布局'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-26-packed-chunk-rows-by-default.i18n.yaml
- Bilingual-pair consistency record for `2026-07-26-packed-chunk-rows-by-default`: English blob `c230c1f1faf5e597321654ebd01d60fae725f518`, Chinese blob `e354efdf6bb68c02f30dc17c8d4ba17a495b61bd`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-26-subprocess-seam.zh.md
- Chinese translation of the sibling English note `2026-07-26-subprocess-seam`: title '进程服务是 bash 执行器之下的独立 seam（`dsh-subprocess` / `dsh-subprocess-local`）'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-26-subprocess-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-26-subprocess-seam`: English blob `bd8cba2197a56acef2ab12e9b43e254fbc744ee5`, Chinese blob `ba23649e9e68f578bdc9ba26a026981d0afe981f`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-27-dispose-ladder-to-consumer.zh.md
- Chinese translation of the sibling English note `2026-07-27-dispose-ladder-to-consumer`: title 'dispose 阶梯归其消费方所有，而非 subprocess seam'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-27-dispose-ladder-to-consumer.i18n.yaml
- Bilingual-pair consistency record for `2026-07-27-dispose-ladder-to-consumer`: English blob `7e1b189c1d3a32c6f812bba5d5f06f7a6a89c29b`, Chinese blob `6c61cad5d4a62c5c976894f72d0ff5e9c69184bc`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-27-tui-chat-channel-module-split.zh.md
- Chinese translation of the sibling English note `2026-07-27-tui-chat-channel-module-split`: title 'dsh-tui 聊天通道模块拆分'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-27-tui-chat-channel-module-split.i18n.yaml
- Bilingual-pair consistency record for `2026-07-27-tui-chat-channel-module-split`: English blob `3cf9548d4d9d1b845bee5f7137d79a490827b082`, Chinese blob `d5de02bd0f7090c24ccfc5dabbbadff9ff42174e`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-28-consolidated-tui-presentation.zh.md
- Chinese translation of the sibling English note `2026-07-28-consolidated-tui-presentation`: title '统一的 TUI 呈现与导航'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-28-consolidated-tui-presentation.i18n.yaml
- Bilingual-pair consistency record for `2026-07-28-consolidated-tui-presentation`: English blob `c772985a11bc61c2bfcbb4422cae219966246163`, Chinese blob `c96fd105bc4ff6632017b16a8b7a0e8f448449bd`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.zh.md
- Chinese translation of the sibling English note `2026-07-28-directory-picker-capability-seam`: title 'web GUI 宿主的能力可辨识目录选择 seam'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-28-directory-picker-capability-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-28-directory-picker-capability-seam`: English blob `e2f3312b7429078eb81cba62ab1727e71fe67b74`, Chinese blob `41a05febe58c353242cc389e20bbf84b3620b7c9`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-28-dsh-native-typescript-source-launch.zh.md
- Chinese translation of the sibling English note `2026-07-28-dsh-native-typescript-source-launch`: title 'dsh 原生 TypeScript 源码启动'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-28-dsh-native-typescript-source-launch.i18n.yaml
- Bilingual-pair consistency record for `2026-07-28-dsh-native-typescript-source-launch`: English blob `b5e8ed2a18bb0cbb3ab54cf5ed4a427efaa9dfeb`, Chinese blob `05a4f92d2d3be553bb9ca363bf08e3ebf8e3f5b8`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-28-user-settings-seam.zh.md
- Chinese translation of the sibling English note `2026-07-28-user-settings-seam`: title '用户设置 seam（`ctx.settings`）与文件提供方'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-28-user-settings-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-28-user-settings-seam`: English blob `75fef5ed976d80acb4e26133c2b98d8504042121`, Chinese blob `9797e5a3288a7709f3541784778c514890015410`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-29-package-regrouping.zh.md
- Chinese translation of the sibling English note `2026-07-29-package-regrouping`: title '按实测聚类重新划分 packages/ 分组'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-29-package-regrouping.i18n.yaml
- Bilingual-pair consistency record for `2026-07-29-package-regrouping`: English blob `7073d868fe73f75477cf9a6fa2c5f7c425d014a8`, Chinese blob `b33ecf1600ce9c9796e932c14c5df9782bb3a94b`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-29-request-level-llm-config-credentials.zh.md
- Chinese translation of the sibling English note `2026-07-29-request-level-llm-config-credentials`: title '请求级 LLM 配置与凭据 seam'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-29-request-level-llm-config-credentials.i18n.yaml
- Bilingual-pair consistency record for `2026-07-29-request-level-llm-config-credentials`: English blob `dda5cd6710ad432a25bce1214078098f4e797559`, Chinese blob `e521920586c8fe9d3a498e0369d1693096562973`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-adapter-owned-max-token-defaults.zh.md
- Chinese translation of the sibling English note `2026-07-30-adapter-owned-max-token-defaults`: title '适配器持有的最大 token 默认值'; 4 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-adapter-owned-max-token-defaults.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-adapter-owned-max-token-defaults`: English blob `30b1840a9ff80092609698e63d061a7d82503e5d`, Chinese blob `770c61ce1514fa8e16d4cbabed4dd97b5b7b40fb`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-client-locale-full-rollout.zh.md
- Chinese translation of the sibling English note `2026-07-30-client-locale-full-rollout`: title 'client 文案全量接入 typed locale 席位'; 4 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-client-locale-full-rollout.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-client-locale-full-rollout`: English blob `381a0ed642d7452cb4be2c9a755bf33c120cba76`, Chinese blob `81ae013e86c6ecb608a15c3664c5203233e27e40`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-command-row-copy-contract.zh.md
- Chinese translation of the sibling English note `2026-07-30-command-row-copy-contract`: title '命令条目文案分别由条目与 handler 负责'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-command-row-copy-contract.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-command-row-copy-contract`: English blob `e5f1828e433015a1381ae4f7951c518bb6040107`, Chinese blob `7efe1aa65ddd992e64807e229b1da682f5bc320b`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-config-plane-boundaries.zh.md
- Chinese translation of the sibling English note `2026-07-30-config-plane-boundaries`: title '配置面暴露什么，以及谁有权覆盖什么'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-config-plane-boundaries.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-config-plane-boundaries`: English blob `6c1f0c8643e9f1b1879b213e01bb8555b6980afe`, Chinese blob `16b05a45afbb944e3ed9f1121e067d8d2bbf1f48`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.zh.md
- Chinese translation of the sibling English note `2026-07-30-session-end-seed-log-boundary`: title '种子结束日志边界'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-session-end-seed-log-boundary.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-session-end-seed-log-boundary`: English blob `d7025aac7a69ffafd4f64a2f73d202e7107452b2`, Chinese blob `5c6227c5866b8a12506709726a1a0f93a8a6dcdc`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-settings-write-path-integrity.zh.md
- Chinese translation of the sibling English note `2026-07-30-settings-write-path-integrity`: title 'settings 写路径完整性与观察者生命周期'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-settings-write-path-integrity.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-settings-write-path-integrity`: English blob `00e9639bc3f2bec8d4f10d3ba30611c822d3d966`, Chinese blob `887941a8bcfadc7f8745b77f2c650452df5df0b9`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-30-web-config-plane.zh.md
- Chinese translation of the sibling English note `2026-07-30-web-config-plane`: title 'web 配置平面'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-30-web-config-plane.i18n.yaml
- Bilingual-pair consistency record for `2026-07-30-web-config-plane`: English blob `ca100f3d5b945e0fc8e048fc8967fd29f77a63cf`, Chinese blob `c24e05b2cd651b543dd7fe40d41505b5a8cee2ae`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md
- Chinese translation of the sibling English note `2026-07-31-claimed-pre-step-inbox-lifecycle`: title '在单一 pre-step 决策前领取 inbox 输入'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.i18n.yaml
- Bilingual-pair consistency record for `2026-07-31-claimed-pre-step-inbox-lifecycle`: English blob `1f5d06b7314e1433880e17cc370a842b153fe287`, Chinese blob `f31790826ea3464ab519a5b21084834390075526`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-07-31-code-runtime-portable-identifier-seam.zh.md
- Chinese translation of the sibling English note `2026-07-31-code-runtime-portable-identifier-seam`: title 'code-runtime seam 拥有可移植标识符排除集'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-07-31-code-runtime-portable-identifier-seam.i18n.yaml
- Bilingual-pair consistency record for `2026-07-31-code-runtime-portable-identifier-seam`: English blob `c7b24e7706a8d27aff8b9d411ea1987bc0e26a17`, Chinese blob `7486727ae8bb2830593f2f33042a46d4d5b846af`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-01-packaged-ripgrep-search.zh.md
- Chinese translation of the sibling English note `2026-08-01-packaged-ripgrep-search`: title 'glob/grep 改用打包的 ripgrep 二进制直接 spawn'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-01-packaged-ripgrep-search.i18n.yaml
- Bilingual-pair consistency record for `2026-08-01-packaged-ripgrep-search`: English blob `24c0c6c68a8f60f90f5da4ba33a358267aabcbbf`, Chinese blob `b40ce6d068e0498fc546fa5fa2a6a005e9783edc`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-03-per-session-agent-presets.zh.md
- Chinese translation of the sibling English note `2026-08-03-per-session-agent-presets`: title '会话的 agent 由一份 preset cordis.yml 组装而成'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-03-per-session-agent-presets.i18n.yaml
- Bilingual-pair consistency record for `2026-08-03-per-session-agent-presets`: English blob `a1f2ad294edfdaaf2dab2d02e858e4dcb0a0c746`, Chinese blob `b745c22c91b4017131a32796c085a869a2eabaf0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-03-pi-ai-declared-provider-catalog.zh.md
- Chinese translation of the sibling English note `2026-08-03-pi-ai-declared-provider-catalog`: title 'pi-ai 路由是被声明的提供方，而不是 catalog 查表'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-03-pi-ai-declared-provider-catalog.i18n.yaml
- Bilingual-pair consistency record for `2026-08-03-pi-ai-declared-provider-catalog`: English blob `b680865b6712e2e53be1eba13956f3626898a047`, Chinese blob `a3b3460acb5a48aecb749269e4c5f1228f749ed9`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.zh.md
- Chinese translation of the sibling English note `2026-08-04-credentials-yaml-and-user-environment-layer`: title '把凭据存储与用户环境层拆开'; 4 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-04-credentials-yaml-and-user-environment-layer.i18n.yaml
- Bilingual-pair consistency record for `2026-08-04-credentials-yaml-and-user-environment-layer`: English blob `37f9aeece6379bc1d4b93dee989043f8f7fa0258`, Chinese blob `d0103a4bf0015121de95e555b0abefd1b63fdfe0`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-04-declaring-a-provider-from-the-models-page.zh.md
- Chinese translation of the sibling English note `2026-08-04-declaring-a-provider-from-the-models-page`: title '在 Models 页上声明一个提供方'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-04-declaring-a-provider-from-the-models-page.i18n.yaml
- Bilingual-pair consistency record for `2026-08-04-declaring-a-provider-from-the-models-page`: English blob `a9326236df9ea4daa6e1cf9a64785c83f523539a`, Chinese blob `8be41b3e2cb3d34b9ac0aa2bc6cd9b74e8304385`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-04-draft-provider-endpoint-interrogation.zh.md
- Chinese translation of the sibling English note `2026-08-04-draft-provider-endpoint-interrogation`: title '询问草稿中的提供方端点'; 5 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-04-draft-provider-endpoint-interrogation.i18n.yaml
- Bilingual-pair consistency record for `2026-08-04-draft-provider-endpoint-interrogation`: English blob `d6de95d91b4c045d4eca793ca7190f6d148888d4`, Chinese blob `eb72884a7119db36549d64a613a5f9d927a1d30a`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-04-websocket-downlink-carrier.zh.md
- Chinese translation of the sibling English note `2026-08-04-websocket-downlink-carrier`: title '浏览器下行 WebSocket 载体'; 6 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-04-websocket-downlink-carrier.i18n.yaml
- Bilingual-pair consistency record for `2026-08-04-websocket-downlink-carrier`: English blob `5edcdd95cf2845d455a61930a9fc00e7e57e72eb`, Chinese blob `213697effb8655583e7c420e58acfd171261a8d8`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-05-large-session-jsonl-restore-pipeline.zh.md
- Chinese translation of the sibling English note `2026-08-05-large-session-jsonl-restore-pipeline`: title '大型会话 JSONL 恢复流水线'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-05-large-session-jsonl-restore-pipeline.i18n.yaml
- Bilingual-pair consistency record for `2026-08-05-large-session-jsonl-restore-pipeline`: English blob `a8d37cc5b18241e5cdfc555f45836c602181ba24`, Chinese blob `734b1feeae3cf28011294c87573a90dea29b2977`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-05-session-preparation.zh.md
- Chinese translation of the sibling English note `2026-08-05-session-preparation`: title '发布前可复用的 Session 准备阶段'; 7 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-05-session-preparation.i18n.yaml
- Bilingual-pair consistency record for `2026-08-05-session-preparation`: English blob `5371fe69dded7f8618bac017fc97c59a6eb0cfb3`, Chinese blob `7b6ad03d266a4d71ccb3e9d54210f9755cbdb1b1`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-05-slot-declaration-injection.zh.md
- Chinese translation of the sibling English note `2026-08-05-slot-declaration-injection`: title 'slot 声明注入与重载生命周期'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-05-slot-declaration-injection.i18n.yaml
- Bilingual-pair consistency record for `2026-08-05-slot-declaration-injection`: English blob `a23e277715cca1074dc3c3c925b126a80734f990`, Chinese blob `21910c5d82ac0f8433ce02532c82c6d7c01b1089`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-06-agent-event-payload-objects.zh.md
- Chinese translation of the sibling English note `2026-08-06-agent-event-payload-objects`: title 'Agent 作用域事件 dispatch 单个 payload 对象'; 4 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-06-agent-event-payload-objects.i18n.yaml
- Bilingual-pair consistency record for `2026-08-06-agent-event-payload-objects`: English blob `b171f2d67e3c065063775e7830b9085af7767c8f`, Chinese blob `65ce0d608c6201d88a607943984349d9b997f8f3`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-06-app-owned-command-line.zh.md
- Chinese translation of the sibling English note `2026-08-06-app-owned-command-line`: title '应用通过 `ctx.cmdlineArgs` 持有自己的命令行'; 5 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-06-app-owned-command-line.i18n.yaml
- Bilingual-pair consistency record for `2026-08-06-app-owned-command-line`: English blob `1a48d00a1f837a900f96345883ce8c96144e49d6`, Chinese blob `067e9c69d9da4e811a0ed182f5eaa664e9a84a81`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-06-subagent-list-identity-projection.zh.md
- Chinese translation of the sibling English note `2026-08-06-subagent-list-identity-projection`: title 'subagent 列表经投影单元读取身份'; 6 `## ` headings, section headings translated (first heading '问题'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-06-subagent-list-identity-projection.i18n.yaml
- Bilingual-pair consistency record for `2026-08-06-subagent-list-identity-projection`: English blob `50937e1f75774438a0be8aef7df6c181ff0fc8a2`, Chinese blob `7b252333549004eab5b81d21e518d6a05729ea2d`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

### .agents/notes/archived/architecture/2026-08-06-web-markdown-incremental-ast-renderer.zh.md
- Chinese translation of the sibling English note `2026-08-06-web-markdown-incremental-ast-renderer`: title '经由直接 mdast 渲染器的增量流式 Markdown'; 4 `## ` headings, section headings kept in English (first heading 'Problem'); a section-for-section mirror of the English decision, alternatives and consequences with no content unique to the Chinese side.

### .agents/notes/archived/architecture/2026-08-06-web-markdown-incremental-ast-renderer.i18n.yaml
- Bilingual-pair consistency record for `2026-08-06-web-markdown-incremental-ast-renderer`: English blob `0491cf519655774df63b957baeb3ce52fc025823`, Chinese blob `25824fa557ec945c9c78f17dcc1a567663883300`; the header names `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write <file>` command for re-recording the pair after an edit to either side.

## Ideas worth stealing

- **A read-before-write guard must be enforced by the WRITER's atomic section, never by a prior check.** `.agents/notes/archived/architecture/2026-06-26-file-context-as-event-gate.md:48` — the observation policy performs *no* filesystem I/O; it only chooses the compare-and-swap basis (`replaceIfVersion` / `createIfAbsent`) and gates on prior observation, and the provider detects staleness inside its mutation critical section. The note names the alternative explicitly: a policy-side `stat` would leave a TOCTOU gap between the check and the write, so the guarantee would be "a false guarantee that the provider's lock has to back up anyway" (`:165`). This is exactly August's read-before-write/edit guard — the freshness decision must live in the same critical section as the write, not in a separate "did you read it?" pass.
- **A policy that can be dropped must not be in the tool's path.** `.agents/notes/archived/architecture/2026-06-26-file-context-as-event-gate.md:35` — "bare `ctx.fs` performs atomic, unconstrained text I/O… Removing the policy therefore leaves the tools usable but unconstrained." The mechanism is the `expected?` parameter: *omit* it for an unconditional mutation, *supply* it for a guarded one, so both modes share one symmetric signature. August's `write_file`/`edit_file` and its hash-anchored edit gate could adopt the same shape (unguarded = unconditional write, guarded = CAS on the file hash) so the safety policy stays a pluggable layer instead of a hard-wired precondition.
- **Retry after a failed request must be authorized by a durable PROOF OF PROGRESS, not by the repair component's return value.** `.agents/notes/archived/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md:38` — the recovery listener snapshots `session.surface.replaceGeneration` and returns `{kind:'retry'}` whenever pruning or summarization *increases* it; "a backend returning a result without replacement cannot authorize a retry, while pruning-only progress can authorize a retry without a `CompactionResult`" (`:52`). August's context-window overflow recovery currently trusts that compaction ran; this gives a checkable predicate.
- **Provider-reported token counts are only valid for the exact envelope that produced them.** `.agents/notes/archived/architecture/2026-07-15-replay-token-meter-service.md:28` — usage is reused "only when the measured canonical request envelope equals the latest successful-call anchor"; any provider/model/system/prefix/tool/call-config change causes complete heuristic repricing, while surface growth is a *signed* delta. Transfer: August's `cost_estimator.price_for_model` and any token-pressure estimate — a cached price is a fact about one request shape, not about the conversation.
- **Do not freeze an abort reason; copy only the fields that become durable.** `.agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.md:16` — undici assigns a `stack` onto the abort reason it receives, so a frozen reason makes `fetch` reject with `TypeError: Cannot add property stack` *in place of* the abort reason. The loop therefore copies the declared fields only where the cause becomes durable data. Any August cancellation token that a transport may touch needs the same rule.
- **Cancellation must be cooperative and the reported idle state must be truthful.** `.agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.md:30` — the loop checks interruption before and after awaited boundaries but deliberately does *not* use `Promise.race` to abandon an in-process listener, adapter or tool promise; work that ignores the signal must settle before `whenIdle()` reports quiescence, because "returning idle while same-process work still runs breaks teardown and resource-ownership guarantees" (`:50`).
- **Turn-scoped, not ambient, cancellation authority; and "one mechanism per independent fact".** `.agents/notes/archived/architecture/2026-07-16-explicit-turn-cancellation.md:16` and `.agents/notes/archived/architecture/2026-07-12-agent-scope-runtime-design.md:18` — the signal is installed per prospective turn, retained through inbox claim, pre-step, prompt assembly, every step and turn-stopping, and cleared immediately before `turn/end`; ALS is rejected because "cancellation authority ends with one turn" and a leaked callback could observe a stale signal. The companion rule — one mechanism per independent fact, no second mechanism for every race — is the generalisation worth stealing.
- **One durable boundary: every session event lives inside a turn.** `.agents/notes/archived/architecture/2026-06-15-turn-enclosure-invariant.md:21` and `:25` — an idle injection becomes a one-shot `turn/start{trigger:{kind:'injection'}}` → `context/message` → `turn/end{completed}`, and the turn number is derived from the log each iteration so the one-shot turn cannot collide with the next real turn. The bug it fixed is the memorable one: an idle background-task notice was durably on disk but *silently dropped on resume* by the log scanner.
- **A crashed turn is closed, never truncated.** `.agents/notes/archived/architecture/2026-06-14-session-persistence.md:24` — flushed events are never rewritten; the *reader* owns balancing and appends synthetic `turn/end {kind:'interrupted'}` closers through its write handle, and only the incomplete fragment of a torn final append is discarded. A parse error or sequence gap in the committed prefix is corruption and makes the session unloadable rather than silently dropping the tail.
- **Tool schemas belong in the same assembly as the prompt text.** `.agents/notes/archived/architecture/2026-06-11-tool-schemas-in-prompt-assembly.md:14` — `PromptAssembly { sections, tools }` means "what the model is told it can do" is one coherent concern, so tool filtering (progressive disclosure) is an *assembly rewrite* rather than a second listener on a second surface. August's `tool_search` → `tool_call` progressive-disclosure path and the system-prompt builder are currently two seams; this collapses them.
- **One typed value per tool execution, projected explicitly into model-facing content.** `.agents/notes/archived/architecture/2026-07-20-canonical-tool-output-contract.md:22` and `:38` — every tool declares `output: { schema, render(args, value), presentationMeta?(args, value) }`; the registry validates and deep-freezes the canonical value, and only `content`/`error`/`meta` are persisted, so "replay reproduces presentation but cannot reconstruct the programmatic result". The consequence August would care about: "content replacement is not a confidentiality mechanism" — a policy that must hide a value from a programmatic caller has to block the call, not rewrite the prose.
- **Adapter owns the reasoning vocabulary, as an opaque branded id, and the core never clamps it.** `.agents/notes/archived/architecture/2026-07-24-adapter-owned-reasoning-effort-capabilities.md:14` — the core requires the selected effort to appear exactly in the adapter's published list; an unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` *before provider I/O*, because "a silent substitution makes the user's selected control differ from the logged request intent". Transfer: August's per-model thinking/reasoning settings should be per-adapter capabilities, not a core enum.
- **Background work: complete all failable preflight before the work starts, and fence it on a controller being present.** `.agents/notes/archived/architecture/2026-06-20-generic-long-running-tool-runtime.md:27` and `:71` — "a producer cannot start work that lacks a collectable job id", and `start()` fails before producer execution when no controller is attached. The check is at *start*, not at plugin load, because sibling plugins may activate concurrently.
- **Split the identity used for authorization from the identity used for lifecycle.** `.agents/notes/archived/architecture/2026-06-20-generic-long-running-tool-runtime.md:51` — the snapshot stores the owner's branded `SessionId` (session equality grants access) while lifecycle operations retain the exact live `Agent` *instance* (object identity selects cleanup and completion delivery), so "reusing an agent or session id cannot redirect an old scope's cleanup or notices to a replacement". Directly applicable to August's background bash job ownership.
- **A derived read model needs no failure channel: absence is the signal.** `.agents/notes/archived/architecture/2026-08-06-subagent-list-identity-projection.md:54` — "a unit never throws; a corrupt payload or an unrecognized version folds exactly like a log with no descriptor at all", and how "computed to nothing" is presented is the consumer's business. Cheaper than a per-key failure channel, and it keeps the read path allocation-free.
- **Read-time computation beats a derived index when there is one consumer.** `.agents/notes/archived/architecture/2026-08-06-subagent-list-identity-projection.md:25` — a three-rung compute-and-discard ladder (live watermark cache → optional checkpoint cache → one body-bearing observation) replaced "values landed with the query index" wholesale, because the latter forced query infrastructure to learn domain vocabulary for a single consumer. Useful when a harness is tempted to build a denormalised store for one screen.
- **Classify every wire message by "who initiates × request/response", not by transport.** `.agents/notes/archived/architecture/2026-07-19-gui-layering-and-rpc-protocol.md:87` and `:110` — exactly four message kinds, `rpcId` minted by the initiator and *echoed* by the responder, so swapping HTTP/SSE for WebSocket/IPC leaves the protocol unchanged. Transfer: August's `/v1/chat/completions` proxy, the ACP bridge and any future MCP transport all need the same discipline or they will diverge on correlation.
- **Two notification channels, chosen by change source.** `.agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.md:75` — `markDirty()` batches frame-driven changes per microtask (N changes, one re-render); `notifyNow()` is for the direct echo of a user gesture, because "controlled inputs roll the DOM back and jump the caret if their echo defers to a microtask". Using `notifyNow` for frame-driven code collapses batching back to per-frame renders — the note bans it explicitly. This is the cheapest streaming-UI win in the shard.
- **Reconnect = rebuild, not resume.** `.agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.md:77` — on disconnect, reopen the stream and refetch history, compare `subscribed.lastSeq` with the history tail and backfill once on a gap; there is no resume cursor. Exponential backoff (500 ms doubling to 10 s, jitter, unlimited) sits behind a *generation fence*.
- **Stream markdown by freezing everything but the last two blocks.** `.agents/notes/archived/architecture/2026-08-06-web-markdown-incremental-ast-renderer.md:17` — the parser keeps the trailing two blocks unstable, freezes the rest and re-parses only the tail from the last frozen block's own `position.end.offset`; each source region then parses O(1) times per stream instead of once per chunk, and a single giant block degrades to the old cost and no worse. August's transcript renderer re-parses on every token today; this is the fix, with a DOM-fixture contract so the swap cannot silently restyle the transcript.
- **Attribute every provider request with the standard header only, and prove it on the wire.** `.agents/notes/archived/architecture/2026-06-21-mandatory-app-attribution-headers.md:28` and `:30` — every adapter sends a static, non-secret `User-Agent` (version read from the package manifest, never a hand-copied constant), asserted by a mock server on the wire; OpenRouter's `HTTP-Referer` and friends are explicitly *not* sent, because "even requests pointed at OpenRouter send only the shared `User-Agent`". A default-off attribution switch was rejected: "a default-off setting is exactly how adapters keep drifting".
- **One registry key for a capability; the access policy lives in the consumer.** `.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md` (Decision section) — exact reads and full-text search over one corpus share a single `ctx.sessionQuery` key, while the *observation strategies* stay separate (exact reads hit authoritative sources per call; FTS reconciles a disposable index). Sharing a key does not make the derived index authoritative.

## Files skipped (with reasons)

- None. All 260 files in this shard were opened and read. No file in the shard is generated, vendored, binary or oversized: the largest is `.agents/notes/archived/architecture/2026-07-12-agent-scope-runtime-design.md` at 38,901 bytes (403 lines) and the smallest is `.agents/notes/archived/architecture/2026-08-06-agent-event-payload-objects.md` at 2,527 bytes.

## Uncertainties

- **The 87 Chinese `.zh.md` files were verified structurally, not read line-by-line.** I read `2026-06-11-content-block-vocabulary.zh.md` in full (a faithful section-for-section translation of its English sibling) and ran a heading-structure comparison across all 87 pairs: every Chinese file has the *same number* of `##` headings as its English sibling (0 mismatches), the same first-section position, and a translated title on line 1. Fourteen of them (`2026-07-19-gui-layering-and-rpc-protocol`, `2026-07-19-gui-web-client-architecture`, `2026-07-23-toolview-dissolution`, `2026-07-27-tui-chat-channel-module-split`, `2026-07-28-consolidated-tui-presentation`, `2026-07-30-adapter-owned-max-token-defaults`, `2026-07-30-client-locale-full-rollout`, `2026-07-31-code-runtime-portable-identifier-seam`, `2026-08-03-pi-ai-declared-provider-catalog`, `2026-08-04-credentials-yaml-and-user-environment-layer`, `2026-08-04-declaring-a-provider-from-the-models-page`, `2026-08-04-draft-provider-endpoint-interrogation`, `2026-08-04-websocket-downlink-carrier`, `2026-08-06-web-markdown-incremental-ast-renderer`) keep their section headings in English ("Problem"/"Decision"/"Consequences"/"Alternatives considered") while the body is Chinese. What I cannot establish from the heading check alone is whether a given Chinese body contains a sentence whose meaning drifts from the English; the per-file entries for the `.zh.md` files are therefore structural descriptions, and the *substance* of each note in this report comes from the English original.
- **The 87 `.i18n.yaml` files are hash records, not prose.** Each is a six-line file: a three-line comment naming `docs/i18n/README.md` and the `pnpm run verify-translation-pairing --write` command, plus the two git blob hashes of the English and Chinese sides. I verified that all 87 carry the expected header and exactly two 40-hex hash lines, and each entry below quotes that file's actual two hashes. I did **not** verify that the recorded hashes match the current file contents — that requires `git hash-object` on the working tree, which is a git operation on the clone, and the shard rules limit me to read/grep/glob plus read-only shell commands. Whether any pair is currently out of sync is therefore unknown.
- **Cross-note references were not followed.** These notes are densely cross-linked to sibling notes in other directories (`../feature/`, `../proposed/`, `../rejected/`, `../simplification/`, `../testing/`) and to `docs/subsystems/*` and `packages/*/README.md` files outside this shard. Where a note says "see X", I recorded the claim as the note states it; I did not open X to confirm the referenced decision says what the citing note says it does. Several notes are explicitly *superseded* by decisions outside the shard, and I marked those supersessions as the notes state them rather than verifying the superseding decision.
- **These are archived notes describing a codebase that has since moved.** Every file carries `Status: implemented` and an `Archived:` date (2026-07-26 through 2026-09-30). Many carry forward-references to decisions dated *after* their own archive date, so the archive is a snapshot of a moving design, and several files state in their own preamble that a later decision supersedes part of them (e.g. `2026-07-19-gui-layering-and-rpc-protocol.md` says the client-plugin loading chain is owned by another note). I did not check the current source tree; this shard describes intent as recorded, not the code as it stands.
- **No lens is unserved, but two are thin in *this* shard specifically.** Agent loop and tool-calling, reasoning/effort, prompt assembly, context management and compaction, model-specific adaptations, subagent execution, tool-call reliability, UI/UX, config and evals all have substantial coverage here. **Prompt caching / prefix stability** appears only in passing — the token-meter note's "any provider, model, system, prefix, tool, or call-config change causes complete repricing" (`2026-07-15-replay-token-meter-service.md:28`) and the `listDir` note's "result order is deterministic … to improve prefix-cache reuse" (`2026-07-03-filesystem-directory-listing-seam.md`); there is no dedicated cache-hit-optimisation note in this shard. **Evals/testing** is covered only as *static* gates — `verify-package-invariants`, the fixture-layout snapshot, the `runPersistenceContract`/`runCoordinatorContract` suites, and various property tests — because this repo's test suite was removed on 2026-10-17 and the notes themselves reference tests that no longer exist (e.g. `2026-07-08-agent-scope-contexts.md` cites "regression-tested" steering behaviour). I could not confirm whether any of those referenced test files still exist, because they are not in this shard and I did not search outside it.
- **The English notes are 87 of the 260 files and carry essentially all the information.** The remaining 173 files (87 translations + 87 hash records) are derivative; if the lead's merge is lossy, the English files are the ones that must survive intact.
