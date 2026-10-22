# deepseek-harness / dsh-subagent

## Shard shape

This shard is the entire **delegation family** of the DeepSeek Harness: 249 files, 44,094 lines, 13 packages under `packages/subagent/` plus three under `packages/experimental/`. The spine is `packages/subagent/subagent` — a Cordis *Service Definition* (`ctx.subagents`) that owns a **named-provider registry** and a **managed-activation manager**. Providers are split into two kinds by the seam itself: *continuable* providers (in-process `spawn` and `fork`) contribute only a `prepareContinuable()` spec and let the manager own the child's whole lifetime, while *external* providers (`acp`, `codex`, `claude-code`, `dsh-sdk`) implement `start()` and return a single execution handle. On top of the seam sit two model-facing tool packages: `tool-subagent` (the provider-bound `subagent` tool that *starts* a child) and `tool-subagent-control` (the globally named `send_message` / `interrupt_agent` / `list_agents` tools that *steer, stop, and discover* continuable children). `packages/experimental/agent-team` is a second-generation, multi-agent composition built on the same seam: an implicit-root "Team" with a durable roster, a peer mailbox, and a compare-and-set shared task DAG; `tool-agent-team` gives it eight scoped model tools, and `agent-team-profile` is a bundle that swaps the plain delegation tools out for the Team ones. The three product providers share a common shape (out-of-process, zero start-time capabilities, one-shot, `NO_START_CAPABILITIES`) and differ only in their wire driver: ACP over ndjson, Codex over a hand-written JSON-RPC app-server adapter, Claude Code over the official Anthropic Agent SDK, and DSH-SDK over the harness's own stdio SDK. Everything durable — child identity, task board, roster, timing — is expressed as **session events plus projections**, never as in-memory state that a restart would lose.

## Per-file notes

### packages/experimental/agent-team-profile/cordis.patch.yml
- Purpose: the experimental Agent Teams profile layer — a Cordis patch that DISABLES `tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent` and `tool-subagent-fork`, then INSERTS the `agent-team` service, the `tool-agent-team` tools, and a `ui-agent-team` Web UI plugin.
- Key abstractions: Cordis patch document (`- id: … disabled: true` / `- insert:`), the same patch grammar the product providers use.
- Data flow: the patch is applied after `dsh-base`, so delegation and coordination land on the Team tools instead of the plain ones.
- Non-obvious design decisions: the profile disables rather than replaces the direct-delegation tools — the comment says so explicitly ("keep direct delegation and coordination on the Team tools"), so the Team layer is a *substitution*, not an addition. Limits are set at the profile (`maxMembers: 8`, `maxTasks: 256`, `maxMessageBytes: 65536`, `disposalTimeoutMs: 5000`), tighter than the service's own defaults.
- Edge cases / failure handling: none — this is a declarative composition file.
- Surprising: the profile names `tool-subagent-fork`, a tool id that does not exist in this shard's manifest; it is disabled defensively so a fork tool loaded by another composition cannot leak into the Team profile.

### packages/experimental/agent-team-profile/icon.svg
- Purpose: the 36×36 plugin icon (two overlapping rounded squares, green→teal and blue→indigo gradients).
- Key abstractions: inline SVG with two `linearGradient` defs, no script.
- Data flow: none; consumed by the plugin card renderer.
- Non-obvious design decisions: uses the shared `dsh_plugin_art_R*` gradient ids so it matches the sibling plugin art.
- Edge cases / failure handling: n/a.
- Surprising: byte-identical to `packages/subagent/subagent-codex/icon.svg` and `packages/subagent/subagent-claude-code/icon.svg` — the repo reuses one generic plugin glyph rather than per-product art.

### packages/experimental/agent-team-profile/locale/en.json
- Purpose: English plugin-card metadata: title "Agent Teams" and a one-line description of the bundle.
- Key abstractions: a two-key `meta` object (`title`, `description`).
- Data flow: read by the host's plugin-listing UI.
- Non-obvious design decisions: the description names all three things the bundle enables ("team collaboration, team tools, the member roster, and the shared task board") so the user can tell it apart from the plain subagent tool.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team-profile/locale/zh.json
- Purpose: Chinese counterpart of the same `meta` block ("智能体团队" / "启用团队协作、团队工具、成员列表和共享任务看板。").
- Key abstractions: same `meta` shape as the English file.
- Data flow: read by the localized plugin card.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: the Chinese file carries a `description` while the English file does not — the pairing gate tolerates this.

### packages/experimental/agent-team-profile/package.json
- Purpose: manifest for `@deepseek-ai/dsh-experimental-agent-team-profile`, version `0.2.1-rc.2`, public.
- Key abstractions: `dsh.bundle.patch` points at `cordis.patch.yml`; `icon` points at `icon.svg`; `files` ships `icon.svg`, `locale/*.json`, `cordis.patch.yml`, `lib/index.js`.
- Data flow: the loader resolves the bundle from the manifest's `dsh.bundle.patch` path.
- Non-obvious design decisions: the package publishes a *patch document* as its real product — `src/index.ts` is empty, so the patch IS the runtime.
- Edge cases / failure handling: n/a.
- Surprising: `publishConfig.access: "public"` for an *experimental* package; `tests/profile.spec.ts` asserts exactly that.

### packages/experimental/agent-team-profile/README.i18n.yaml
- Purpose: per-section EN/ZH content hashes for the bilingual pairing gate (`pnpm run verify-translation-pairing --write`).
- Key abstractions: a YAML map from heading path → `{ en: <hash>, zh: <hash> }`.
- Data flow: consumed by the translation-pairing checker in CI.
- Non-obvious design decisions: the hash covers the section text *outside* code blocks and generated regions, so a code-fence edit does not require re-recording.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team-profile/README.md
- Purpose: the English package reference for the Agent Teams bundle.
- Key abstractions: the standard README skeleton — Summary / Use this package / Understand the implementation / Further Exploration / Model Experience / Known Limitations / Dev Note.
- Data flow: n/a (documentation).
- Non-obvious design decisions: the front-matter `kind: "package-reference"` and `description:` are what the doc site and the `check:docs` gate read.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team-profile/README.zh.md
- Purpose: the Chinese translation of the package reference, section-for-section.
- Key abstractions: same heading structure as the English file.
- Data flow: linked from the English file's "English | 中文" line.
- Non-obvious design decisions: the pairing hashes in `README.i18n.yaml` are what keep the two sides from drifting.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team-profile/src/index.ts
- Purpose: an intentionally EMPTY module — the package's runtime content is its `cordis.bundle.patch` document, so the entry point exports no API.
- Key abstractions: `export {}` only; the module docblock names the reason.
- Data flow: none.
- Non-obvious design decisions: shipping an empty `src/index.ts` rather than omitting it, because the package must still resolve as a Cordis plugin with a `lib/index.js` artifact.
- Edge cases / failure handling: n/a.
- Surprising: a plugin package whose TypeScript file contains eight lines and no code — a pattern worth knowing before you go looking for the logic.

### packages/experimental/agent-team-profile/tests/profile.spec.ts
- Purpose: asserts the bundle is a public, parseable, explicit Team layer.
- Key abstractions: `entryListSchema` from `@deepseek-ai/cordis-plugin-include` parses the patch; `js-yaml` loads it.
- Data flow: reads the package's own `package.json` and `cordis.patch.yml` off disk.
- Non-obvious design decisions: the test checks `manifest.private` is `undefined` and `publishConfig.access === 'public'` — the *publishability* of an experimental package is a tested property, not a convention.
- Edge cases / failure handling: n/a.
- Surprising: a test that reads its own package manifest, so a packaging mistake fails a unit test rather than only a release job.

### packages/experimental/agent-team-profile/tsconfig.json
- Purpose: TypeScript project config — `rootDir: src`, `outDir: lib/types`, extends the repo base.
- Key abstractions: project references to the base plus the packages the (empty) source needs.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/src/activity.ts
- Purpose: the one-shot "wait for the next Team change" waiter registry — the primitive behind `wait_agent`.
- Key abstractions: `TeamActivity` owns a `Map<TeamId, Set<Waiter>>`; `wait(id, timeoutMs, signal)`, `notify(id)`, `close()`.
- Data flow: `TeamService.waitForChange` → `activity.wait`; every Team-domain commit and every member status change calls `activity.notify(teamId)`.
- Non-obvious design decisions: the timeout is validated to a narrow band (10 000 ms – 3 600 000 ms) *inside* the service, so a hostile or sloppy caller cannot pin a waiter open; the waiter is removed on every exit path through a single `finish()` closure that also handles the "abort fires between the pre-check and the listener registration" race (line 61-63).
- Edge cases / failure handling: `close()` wakes every waiter during service disposal; a closed service returns `{ timedOut: false }` immediately rather than hanging.
- Surprising: `notify` DELETES the waiter set before resolving it, so a change that arrives during resolution is not lost but also not double-delivered.

### packages/experimental/agent-team/src/client.ts
- Purpose: browser-safe re-export surface — the Team roster/task view types and the `agentTeam` projection vocabulary.
- Key abstractions: a pure `export type { … } from './types.ts'` barrel.
- Data flow: consumed by the Web UI bundle, which must not pull server code in.
- Non-obvious design decisions: only *types* cross this boundary; the `client` export subpath exists so the browser build never imports the service.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/src/error.ts
- Purpose: the typed Team failure (`TeamError extends HarnessError`) plus a bounded `errorMessage()` renderer for arbitrary thrown values.
- Key abstractions: a stable `code` string on every error (`TEAM_MEMBER_NOT_FOUND`, `TEAM_TASK_STALE_REVISION`, `TEAM_DISPOSED`, …).
- Data flow: `errorMessage` is used where an error text is persisted into a durable member snapshot (`roster.ts` `error:` field).
- Non-obvious design decisions: `errorMessage` uses `node:util.inspect` with `depth: 4` and `compact: true` so a non-Error throw still produces a *bounded single line* rather than an unbounded object dump — a durable record cannot hold an arbitrary structure.
- Edge cases / failure handling: n/a.
- Surprising: the same helper is reused for the runtime's own `logger.warn` calls, so a persisted failure and a log line have identical text.

### packages/experimental/agent-team/src/index.ts
- Purpose: the `TeamService` façade over four owners (roster, journal, task board, activity) plus the runtime lifecycle.
- Key abstractions: `Service extends Cordis.Service`; `inject = ['agents','sessions','sessionPersistence','sessionProjections','subagents']`; config `maxMembers`/`maxTasks`/`maxMessageBytes`/`disposalTimeoutMs`.
- Data flow: `spawnTeammate` → `roster.spawn` → `ctx.subagents.startActivation` (the Team is built ON the subagent seam); `sendMessage` → `steerHostSubagentPrompt` for a teammate or `root.steer()` for the Lead; `createTask`/`updateTask` → `tasks.*` → `journal.transact` → `journal.appendAndFlush` → a `team/*` event on the Lead's Session → the `agentTeam` projection.
- Non-obvious design decisions: the Team is *implicit* — there is no "create a team" call; a Team identity IS the root Session id. `sendMessage` frames the payload as `Team message from <name>:` and uses the ordinary `agent-message`/`relay` source, so the Lead's transcript shows the sender. Message size is checked on the *serialized* content (`Buffer.byteLength(JSON.stringify(content))`) because that is what crosses the wire.
- Edge cases / failure handling: `sendMessage` refuses self-messaging (`TEAM_SELF_MESSAGE`); a caller that is not a Team member is refused by `roster.membership`. Disposal closes the lifecycle cutoff, settles tracked operations, then drains every live Team child.
- Surprising: the service registers a projection in `ctx.root` and disposes it in an effect whose disposer *also* awaits the runtime drain — the projection outlives nothing.

### packages/experimental/agent-team/src/journal.ts
- Purpose: the serialized transaction owner for Team state — one queue per Lead Session, and the append+flush that publishes a Team event.
- Key abstractions: `TeamJournal.transact(rootId, operation)` (a per-root promise chain), `appendAndFlush(root, type, data)`, `state(root)`.
- Data flow: `transact` serializes a read-check-append sequence against the Lead's `agentTeam` projection; `appendAndFlush` appends the event then `ctx.sessions.flush(root.session)` and only then notifies the activity waiters.
- Non-obvious design decisions: the flush is *inside* the transaction, so a reader of the projection never sees an un-flushed Team fact. `append` is reached through a narrowed local type alias because `Session.append` takes a conditional `surfaceOp` argument that Team events do not have ("Team events never enter the conversation surface") — the narrowing removes the argument rather than passing a dummy.
- Edge cases / failure handling: a failed operation still releases the queue (the tail absorbs the rejection, `prior.then(operation, operation)` runs the next operation either way).
- Surprising: `state(root)` THROWS when the projection carries a `failure` — a corrupt Team log is a hard error on the read path, not a silently empty roster.

### packages/experimental/agent-team/src/lifecycle.ts
- Purpose: the single Team runtime admission cutoff and the bounded settlement that keeps HMR and shutdown from hanging.
- Key abstractions: `TeamRuntimeLifecycle` with one `AbortController`, a set of tracked operations, and `withTimeout`.
- Data flow: every admitted operation is `track()`ed; `close()` aborts the controller; `settle(operations, failures)` awaits them all and keeps only the rejections that are not the runtime cancellation.
- Non-obvious design decisions: `isCancellation` walks the whole `Error.cause` chain looking for the runtime's own reason or a `TEAM_DISPOSED` code — the check is deliberately transitive because a cancellation is often wrapped. The `disposalTimeoutMs` bound exists because "settlement may otherwise block HMR or process shutdown" (line 88).
- Edge cases / failure handling: a timeout is recorded as a failure in the aggregate rather than swallowed; expected cancellations are excluded so a clean disposal does not report an error.
- Surprising: the same lifecycle object supplies the `AbortSignal` that is `AbortSignal.any`-ed into every Team operation's own signal, so a caller's cancellation and the runtime's cancellation are indistinguishable downstream.

### packages/experimental/agent-team/src/persisted.ts
- Purpose: a short-lived read handle over a persisted Team member Session.
- Key abstractions: `readPersistedSession(persistence, id, signal)` returning `{ inheritedEventCount, header, events }`.
- Data flow: used by `roster.checkpointInitialPrompt` (to prove the initial prompt landed durably) and `roster.reconcileProvisioning` (to decide whether an orphaned `provisioning` member is `active` or `failed`).
- Non-obvious design decisions: the handle is closed in a `finally` before the value is returned, so a durable read never leaves a file handle open — the same reason the repo's other restore path is staged rather than in-process.
- Edge cases / failure handling: `open`/`read` failures propagate to the caller, which converts them into a `failed` member phase.
- Surprising: the returned `inheritedEventCount` is what lets the caller separate the child's OWN log from a fork seed — the Team's recovery decision depends on it.

### packages/experimental/agent-team/src/projection.ts
- Purpose: the `agentTeam` session projection — durable Team state folded from `team/*` events, plus the durable-only client view.
- Key abstractions: `teamProjectionDefinition` (key `agentTeam`, `stateVersion: 4`), `TeamState` (members/tasks/messages/delivered/nextTaskNumber), `teamProjectionView(state)`.
- Data flow: every `team/member`, `team/task`, `team/message/queued`, `team/message/delivered` event on the Lead's log is folded into the state; the wire view publishes the Lead pseudo-row, the roster, and the non-deleted task board.
- Non-obvious design decisions: the fold *enforces* the state machine — a member must begin `provisioning`, may only move `provisioning → active|failed`, may not change its immutable name/provider/context, and a task's revision must be contiguous; a violation is caught and stored as `state.failure` rather than thrown, so a bad event freezes the projection instead of breaking the whole Session. The view is memoised in a `WeakMap` keyed by the *members array* and then the *tasks array*, so a mailbox-only change (which touches neither) publishes nothing.
- Edge cases / failure handling: an unsupported event version throws into the `failure` sentinel; `null` (not `undefined`) is used where a value must survive `JSON.stringify` in a pushed projection frame — see `projection-types.ts` for the same discipline in the subagent package.
- Surprising: the fold is a *validator as well as a projector* — it re-checks the task dependency graph on every task event (`assertTaskGraphCandidate`), so a corrupt log cannot produce a cyclic task board.

### packages/experimental/agent-team/src/roster.ts
- Purpose: Team identity resolution, continuable-child provisioning, and roster-owned teardown.
- Key abstractions: `TeamRoster` (membership resolution, `spawn`, `interrupt`, `liveChildrenByRoot`, `stopTeammates`, `recoverFor`) plus the free function `resolveActiveMember`.
- Data flow: `spawn` writes a `team/member` event with phase `provisioning` (flushed), then calls `ctx.subagents.startActivation` with the reserved `childId`, then checkpoints that the child's initial prompt was *durably accepted*, then appends the terminal `active`/`failed` member edge. `interrupt` delegates to `ctx.subagents.interrupt(target.id, { kind: 'ancestor', agent: caller })`.
- Non-obvious design decisions: the roster is the *only* writer of `team/member`, and the phase is a two-phase commit: `provisioning` is durable before the child exists, so a crash leaves a recoverable marker; recovery (`reconcileProvisioning`) reads the child's OWN persisted suffix and promotes it to `active` only if the descriptor says `continuable`, the provider matches, and a user message was accepted — otherwise it becomes `failed` with a reason. Teammate names are lower-kebab-case, ≤64 chars, never `lead`, and never reused.
- Edge cases / failure handling: a creation that reports failure while the member has already become `active` raises `TEAM_PROVISIONING_CONFLICT` rather than inventing an impossible `active → failed` transition; both the creation error and the recording error are aggregated. A member whose durable child cannot be read becomes `failed` with a descriptive error string.
- Surprising: `tryMembership` deliberately returns `undefined` for a session that carries a `subagent/descriptor` — a provider-owned subagent child must NOT be reinterpreted as a new implicit Team root, and a host-resumed ordinary fork (no descriptor) IS a valid new root.

### packages/experimental/agent-team/src/session-message.ts
- Purpose: durable "was this message accepted?" checks used to gate teammate provisioning.
- Key abstractions: `messageAccepted(events, predicate)` — true when the message is in `user/message` history OR still pending in the inbox.
- Data flow: folds `agent/inbox/spliced` events into a two-lane inbox projection (`next-turn`, `next-step`) by replaying `start`/`removedCount`/`inserted`, then searches both.
- Non-obvious design decisions: the inbox is reconstructed from splice events rather than read from a live structure, because the check must also work against a *persisted* session read from disk (the recovery path). A message accepted into the inbox but not yet run is still "accepted" — that is the whole point of the fold.
- Edge cases / failure handling: `removedCount` of `undefined` is treated as 0.
- Surprising: this is the only place in the shard that reconstructs inbox state from an event log, and it is the piece that lets a restarted Team decide "did the teammate really get its first prompt?".

### packages/experimental/agent-team/src/task-board.ts
- Purpose: the shared Team task DAG — creation, listing, and compare-and-set mutation.
- Key abstractions: `TeamTaskBoard` with `create`, `get`, `list`, `update`; eight `TeamTaskAction`s (claim/release/edit/set_dependencies/complete/reopen/reassign/delete).
- Data flow: every mutation runs inside `journal.transact(root.id, …)`, checks `current.revision !== request.expectedRevision` and refuses with `TEAM_TASK_STALE_REVISION`, validates the dependency graph, then appends a whole `team/task` snapshot with `revision: current.revision + 1`.
- Non-obvious design decisions: the *whole* task value is written on every mutation (not a patch), so a replayed log reconstructs state exactly; the revision is a CAS fence, which is what makes two agents claiming the same task safe; `claim` requires `taskReady` (all blockers completed) and refuses a task owned by another member; `delete` refuses while a live task still depends on it.
- Edge cases / failure handling: `TEAM_TASK_ALREADY_CLAIMED`, `TEAM_TASK_BLOCKED`, `TEAM_TASK_INVALID_TRANSITION`, `TEAM_TASK_UNAUTHORIZED`, `TEAM_TASK_HAS_DEPENDENTS` — each mutation failure has its own code. Only the Lead may `reassign`.
- Surprising: `authorizeOwner` allows the *owner* OR the Lead to mutate, so a teammate can mark its own work complete but a peer cannot.

### packages/experimental/agent-team/src/task-graph.ts
- Purpose: the shared, complete dependency validator for the task DAG.
- Key abstractions: `assertTaskGraphCandidate(current, candidate)` and the `TeamTaskGraphError` with a `violation` of `'missing' | 'duplicate' | 'cycle'`.
- Data flow: builds the post-mutation task map, then runs a two-phase DFS (`visiting`/`visited`) over the blocker edges.
- Non-obvious design decisions: the validator is called from BOTH the command path (`task-board.ts`) and the projection fold (`projection.ts`), so a log written by a different path is still checked — a corrupted board cannot be projected into a cyclic one.
- Edge cases / failure handling: self-blocking is a `cycle`; a repeated blocker is a `duplicate`; a blocker that is missing or `deleted` is `missing`. Deleted tasks are skipped as blockers but a live task may not depend on one.
- Surprising: it is O(V+E) per mutation but re-validates the WHOLE graph, not just the changed task — deliberate, because a dependency change can break a cycle anywhere.

### packages/experimental/agent-team/src/task-view.ts
- Purpose: the pure derivation of a task view (owner name, readiness, write-scope warnings) shared by the board and the client projection.
- Key abstractions: `taskReady(state, task)` and `projectTaskView(state, task)`.
- Data flow: reads sibling tasks from `TeamState` and produces the `TeamTaskView` the tools and the wire view use.
- Non-obvious design decisions: write-scope overlap is ADVISORY, not a lock — `scopesOverlap` compares path *components* (`left.startsWith(right + '/')`), not raw prefixes, so `src` and `src-old` do not overlap. The docblock states the caller may pass its pre-append state because the candidate snapshot is supplied explicitly.
- Edge cases / failure handling: only `in_progress` siblings can produce a warning; a task that is not `pending` is never `ready`.
- Surprising: `ready` requires `status === 'pending'` AND all blockers completed — a completed task reports `ready: false` even though nothing blocks it.

### packages/experimental/agent-team/src/types.ts
- Purpose: the public Agent Teams vocabulary — branded identities, durable snapshots, runtime views, service requests, and the four `team/*` session event shapes.
- Key abstractions: `TeamId`/`TeamTaskId`/`TeamMessageId` (branded strings), `TeamMemberSnapshot` (durable) vs `TeamMemberView` (runtime-enriched), `TeamTaskSnapshot` (durable, `revision`) vs `TeamTaskView`, `TeamProjection`.
- Data flow: declares the `team/member`, `team/task`, `team/message/queued`, `team/message/delivered` entries in `SessionEventMap` and the `agentTeam` entry in `SessionProjectionMap`, plus a `team-message` entry in `MessageSourceMap`.
- Non-obvious design decisions: durable and runtime shapes are SEPARATE types on purpose — the durable one is what a log can hold (no live model, no status), the runtime one is what a tool returns. The mailbox events are marked "Historical"; new sends use the target Agent's inbox instead, so the events exist for compatibility rather than as the live path.
- Edge cases / failure handling: every event payload carries `version: 2` and a `teamId` so a fold can select its own Team and refuse another version.
- Surprising: `TeamMemberSnapshot.phase` is `'provisioning' | 'active' | 'failed'` — a third state that exists only because creation is a two-phase durable commit.

### packages/experimental/agent-team/src/validation.ts
- Purpose: input normalization shared by roster and task commands.
- Key abstractions: `requiredText(value, field, maxLength)` and `writeScope(value)`.
- Data flow: called by `roster.memberName`'s callers and `task-board` for subject/description/write scopes.
- Non-obvious design decisions: `writeScope` rejects absolute paths, Windows drive prefixes, `.`/`..` segments, and empty segments — it is a *workspace-relative prefix* and explicitly "not a lock" (the docblock says so). The docblock's phrasing "without treating it as a lock" is the key caveat: the scope is advisory metadata for human/model coordination, never an enforcement boundary.
- Edge cases / failure handling: backslashes are normalized to `/` first, so a Windows-authored scope is accepted.
- Surprising: `writeScope` accepts `src/app` but rejects `src//app` — an empty segment is a path-traversal shape, not a typo.

### packages/experimental/agent-team/tests/built-lib.e2e.ts
- Purpose: a plain-Node smoke test that the *built* `lib/index.js` of the Agent Teams service loads under Node.
- Key abstractions: `execFile` on the built artifact; the test self-skips when `packages/experimental/agent-team/lib/index.js` does not exist.
- Data flow: boots the built service and the host-side `client`/`types` subpaths.
- Non-obvious design decisions: `describe.skipIf(!requiredArtifacts)` — the built-lib test is conditional on a build having happened, so it never fails a source-only checkout.
- Edge cases / failure handling: n/a.
- Surprising: this is a *packaging* test disguised as a unit test: it catches a build that produced a bundle the host cannot import.

### packages/experimental/agent-team/tests/persistence.spec.ts
- Purpose: durable-Team coverage — roster/task events survive a persistence round-trip and the projection refolds them.
- Key abstractions: JSONL session persistence; `teamProjectionDefinition`; `readPersistedSession`.
- Data flow: writes Team events, flushes, re-reads the persisted Session, and re-projects.
- Non-obvious design decisions: it also mounts the real `SubagentService` + `SubagentSpawn` provider, so the roster's continuable-child path is exercised against the production seam rather than a stub.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/tests/projection-events.spec.ts
- Purpose: the pure projection fold — every `team/*` event shape, every valid and invalid transition.
- Key abstractions: `project(rootId, events)` builds a `TeamProjectionState` by calling `apply` directly, exactly as the registry would.
- Data flow: no services; it drives `teamProjectionDefinition` and `teamProjectionView` with synthetic events.
- Non-obvious design decisions: the fold is tested in isolation from any service, which is what makes the state machine cheap to pin.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/tests/team.spec.ts
- Purpose: the end-to-end Team behaviour suite (1,361 lines): roster, messaging, task DAG, provisioning recovery.
- Key abstractions: real `AgentLoop`, `MockAdapter`, JSONL persistence, `SubagentService` + spawn/fork providers, `TeamService`.
- Data flow: mounts the real stack, spawns teammates, exchanges peer messages, drives the task board through claim/edit/complete/reassign/delete, and exercises the durable provisioning recovery path.
- Non-obvious design decisions: the suite reaches into the service's internals to place deterministic races (`checkpointInitialPrompt` is spied on and mocked at lines 322/399/411) — the Team's two-phase provisioning commit is only testable by reaching the private seam.
- Edge cases / failure handling: n/a.
- Surprising: the task-board assertions are written entirely in terms of `expectedRevision` (dozens of them), so every task mutation in the suite is a CAS operation.

### packages/experimental/agent-team/tests/test-session-query.ts
- Purpose: a minimal concrete `SessionQueryEngine` for the Team tests.
- Key abstractions: overrides `searchSessions()`/`searchEvents()` to reject.
- Data flow: n/a.
- Non-obvious design decisions: the search faces deliberately throw rather than return empty, so a test that accidentally depends on search fails loudly.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/tsconfig.json
- Purpose: TypeScript project config for the Team service (`rootDir: src`, `outDir: lib/types`).
- Key abstractions: project references to `dsh-subagent`, `dsh-session`, `dsh-session-projection`, and the cordis vendor packages.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/package.json
- Purpose: manifest for `@deepseek-ai/dsh-experimental-agent-team`, v `0.2.1-rc.2`, public.
- Key abstractions: three export subpaths — `.` (the service), `./client` (browser-safe types), `./types`.
- Data flow: the loader imports `.`; the Web UI imports `./client`.
- Non-obvious design decisions: `./client` and `./types` are separate subpaths so the browser bundle never pulls the service implementation.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/README.i18n.yaml
- Purpose: EN/ZH section hashes for the Team package README.
- Key abstractions: same `/{path}/{heading}: {en, zh}` map shape as the sibling packages.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/README.md
- Purpose: the English reference for the Team service — roster semantics, peer messaging, the task DAG, and the "Teams are implicit" model.
- Key abstractions: the standard README skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the README documents the *limits* (roster names never reused, task ids are numeric and monotonic, `team/member` events live only in the Lead's log) as first-class contract, not as caveats.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/README.zh.md
- Purpose: the Chinese translation of the Team package reference.
- Key abstractions: same section structure as the English file.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/locale/en.json
- Purpose: English plugin-card metadata — "Team Collaboration" / "Manage team members, member messages, and shared tasks."
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/locale/zh.json
- Purpose: Chinese plugin-card metadata — "团队协作" / "管理团队成员、成员消息和共享任务。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/agent-team/tsdown.config.ts
- Purpose: the tsdown build config — one ESM, Node-platform, es2024 entry per export subpath, `dts: false` (declarations come from `tsc`).
- Key abstractions: `entry(path)` helper producing a `SubprocessSpawnSpec`-like build record.
- Data flow: the release build emits `lib/index.js`, `lib/client.js`, `lib/types.js`.
- Non-obvious design decisions: `fixedExtension: false` and `clean: false` so the build coexists with the `tsc`-emitted `lib/types` tree.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/locale/en.json
- Purpose: English plugin-card metadata for the Team tools — "Team Tools" / "Give agents tools to coordinate members, exchange messages, and manage shared tasks."
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/locale/zh.json
- Purpose: Chinese plugin-card metadata for the Team tools — "团队工具" / "为智能体提供成员协调、消息通信和共享任务管理工具。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/package.json
- Purpose: manifest for `@deepseek-ai/dsh-experimental-tool-agent-team`, v `0.2.1-rc.2`, public.
- Key abstractions: a `schemastery` dependency plus peer dependencies on `dsh-experimental-agent-team`, `dsh-tools`, `dsh-system-prompt`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/README.i18n.yaml
- Purpose: EN/ZH section hashes for the Team tools README.
- Key abstractions: the same per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/README.md
- Purpose: the English reference for the eight Team tools (`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_create/list/get/update`).
- Key abstractions: the standard README skeleton with a Model Experience section describing the exact prompt text the model sees.
- Data flow: n/a.
- Non-obvious design decisions: the README treats the `team:policy` system-prompt paragraph as a *contract* and quotes it, because that paragraph is the thing that makes a multi-agent session behave.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/README.zh.md
- Purpose: the Chinese translation of the Team tools reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/experimental/tool-agent-team/src/index.ts
- Purpose: the eight scoped model-facing Team tools, installed into each Team member's OWN agent scope.
- Key abstractions: `jsonOutput(schema)` declares a canonical output schema so the compiler checks `execute` against the promised value; `install(agent, ctx, config)` registers tools + two prompt contributions into `agent.ctx`.
- Data flow: `apply()` walks `ctx.agents.list()`, installs into every Agent with a Team membership, and re-installs on `agent/created` / removes on `agent/disposed`; a `ctx.effect` disposer removes them all on plugin unload.
- Non-obvious design decisions: the tools are installed **per Agent scope**, not globally, so a non-Team agent never sees them. `wait_agent` has a *model-only* shortcut: it reads the roster synchronously and, if no other member is `running` or `provisioning`, returns `{ timedOut: false, noProgress: { reason: 'no-active-peer', message: … } }` immediately instead of sleeping — the tool explicitly never wakes an inactive peer, so waiting on one is a guaranteed waste of a turn. The `team:identity` runtime-context contribution tells a teammate its own name and that the Lead is named "lead", and the `team:policy` section teaches the model the FS_STALE_VERSION rebase protocol and that write-scope overlap is advisory.
- Edge cases / failure handling: the installer collects disposers and reverses them if any registration throws, so a partial install is fully rolled back. `team_task_list` validates `cursor`/`limit` itself. An out-of-range `timeout_ms` is passed through to the service so the service's own validation stays authoritative.
- Surprising: `send_message` here REPLACES the global `send_message` tool — the Team profile disables `tool-subagent-control` precisely so this Team-scoped version owns the name.

### packages/experimental/tool-agent-team/tests/tool-team.spec.ts
- Purpose: the Team tool suite (727 lines) — every tool, the prompt contributions, and the no-progress shortcut.
- Key abstractions: real `AgentLoop` + `MockAdapter`; `renderPrompt`/`renderContextSnapshot` from `dsh-system-prompt` to assert the exact model-visible text; `scopeOf` to assert per-agent installation.
- Data flow: mounts the Team service, installs the tools, and calls them through the real tool runtime.
- Non-obvious design decisions: the suite asserts on the *rendered prompt*, not on the tool registration, because the prompt text is the mechanism that makes a model use the tools correctly.
- Edge cases / failure handling: the `noProgress` shape is asserted at line 465.
- Surprising: n/a.

### packages/experimental/tool-agent-team/tsconfig.json
- Purpose: TypeScript project config for the Team tools package.
- Key abstractions: references to `dsh-experimental-agent-team`, `dsh-tools`, `dsh-system-prompt`, `dsh-subagent`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/README.md
- Purpose: the package-group README for `packages/subagent/` — a table of the nine packages and their `ctx` keys.
- Key abstractions: `kind: "package-group"` front-matter distinguishes it from a `package-reference`.
- Data flow: n/a.
- Non-obvious design decisions: the table's "ctx key" column makes the layering explicit: the seam owns `ctx.subagents`, the backends *register on* it, and the tools register on `ctx.tools`.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/README.zh.md
- Purpose: the Chinese translation of the package-group README.
- Key abstractions: same table structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/README.i18n.yaml
- Purpose: EN/ZH section hashes for the package-group README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/src/index.ts
- Purpose: the Service Definition — `ctx.subagents`, a named-provider registry, and a capability-validating asynchronous start API.
- Key abstractions: `SubagentRuntime extends TypertRemoteService`; `Config { maxDepth, maxActiveSubagents }` (both `Volatile`); the `subagent/provider-added|removed|start|end` events.
- Data flow: `startActivation(spec)` → capability check → `manager.startLocal(spec)` (when the provider has `prepareContinuable`) or `manager.startExternal(spec)`; the manager owns execution, delivery, and release.
- Non-obvious design decisions: **method presence selects the execution mode** — a provider with `prepareContinuable` is a local continuable child, a provider with `start` is a one-shot external execution, and a provider with neither is rejected at *registration* with `UNSUPPORTED_CAPABILITY`. The service asserts the parent is the EXACT live registry entry (`this.ctx.get('agents')?.get(parent.id) !== parent` → `UNAUTHORIZED`), so a stale Agent object cannot spawn. `assertCapabilities` rejects the FIRST unsupported capability rather than accepting-then-ignoring. The `prompt` and `interruptByParent` Remote methods admit image parts through the attachment store *before* delivery, so the wire never carries a durable attachment reference the caller could fabricate.
- Edge cases / failure handling: `startActivation` with a reserved `childId` requires a local backend; a missing `agents` service yields `CONTINUATION_UNAVAILABLE`; a missing provider yields `NO_PROVIDER`; a duplicate provider name yields `DUPLICATE_PROVIDER` at registration.
- Surprising: `resolveMaxDepth(configured)` is the single place the depth policy is read, and `'provider-managed'` returns `undefined` — a depth cap the PROVIDER owns is expressed as "no cap from us", not as a special number.

### packages/subagent/subagent/src/manager.ts
- Purpose: the heart of the seam — startup, message admission, cold resume, capacity, parent ownership, settlement, and disposal for every provider.
- Key abstractions: `SubagentManager`; `Activation`/`LocalActivation` (from `activation.ts`); `ChildLock`; `ActivationPool`; `Materialization` (lineage + settled promise + controller).
- Data flow: `startLocal` → `resolveDirectory` → `host.prepareContinuable` → `locks.run(childId, …)` → `materialize` → `ownerCtx.agents.create`/`resume` → `submitMaterialized` → `establishCatalogChild`; `startExternal` → `host.startExternal` → `establishExternalCatalogChild` → `announce`. A local child is then watched by `watchLocalSettlement`, which loops on `agent.whenIdle()` + `settlementState` and closes the activation when the inbox is empty, no children are owned, and the final Session flush changed nothing. `receipt(activation)` binds the returned capabilities to the EXACT activation epoch, "instead of a future same-id instance".
- Non-obvious design decisions: **policy and options are snapshotted BEFORE the first await** (lines 388-404: "a later parent switch belongs to the parent's future, not to this child"). The *stop reason* is derived from the child's own log (`epochStopReason`), never from the fact that disposal succeeded — "teardown succeeding says nothing about whether the model errored". The capacity slot is reserved BEFORE the asynchronous child creation and released only after the handle's disposal completes. A `closingScopes` map closes admission for one exact parent tree until that exact root leaves the registry, so a same-id replacement is not poisoned. The manager registers its structural disposer FIRST and the drain SECOND so reverse unwind runs the drain before releasing the handles. The settlement notice's delivery mode is chosen by the parent's CURRENT status — `queue` when idle (one independent model request), `steer` when busy (none) — and if the parent is already tearing down the message is `inject`ed rather than sent, so it is not lost.
- Edge cases / failure handling: every unpublished failure rolls the activation back and rejects the result promise with the original error; a disposal failure is reported as a separate `ACTIVATION_TEARDOWN_FAILED` and does not replace the captured result; `disposeRoots` reports every branch failure *after* all branches settle, so one bad branch does not pin the rest; the settlement notice is delivered even when the child already sent a message, because the parent-side tool description promises it; a rejected settlement notice is LOGGED, never allowed to fail the child's teardown.
- Surprising: `holdOwnership` lets a parent keep a slot while a caller is still creating its child, so the parent cannot settle out from under an in-flight delegation; the "rechecks" loop in `watchLocalSettlement` re-validates the Session sequence *after* the final flush, which is why a child that accepted work during the flush stays resident; and the final Session flush is best-effort — its failure is logged with an explicit warning that "the persisted state may be unavailable or stale on resume" rather than turning a successful child into an error.

### packages/subagent/subagent/src/activation.ts
- Purpose: the execution-period records — capacity slots, per-child serialization, local output capture, and the failure observer.
- Key abstractions: `ActivationPool` (a `Set<symbol>` of reserved slots), `ChildLock` (a per-child promise chain), `Activation`/`LocalActivation`, `observeLocalFailure`, `captureLocalResult`. The `ActivationBase` record carries `pool`, `releaseSlot`, `childId`, `parent`, `delivery`, `result`, `closing`, `ancestry`, `ownedChildren`, `observer`, `announced`.
- Data flow: `pool.reserve(capacity)` returns an idempotent release; `locks.run(childId, op)` serializes delivery, release, and disposal for one child; `captureLocalResult(activation)` reads the epoch's own event suffix and folds the output and stop reason.
- Non-obvious design decisions: the capacity pool is keyed on a **root** (`rootPools` is a `WeakMap<Agent, ActivationPool>`) so a root and all its descendants share slots while separate roots are isolated. `ChildLock` absorbs rejections in its chaining tail ("one failed critical section cannot reject an unrelated later caller"). `observeLocalFailure` records the *latest live failure* at a session seq and clears it when a later committed `turn/end` supersedes it — a failed child that recovers reports the recovered outcome. `ancestry` is a `WeakSet<Agent>` of the live ancestry observed at materialization, so "Weak membership preserves host-scope identity across an intermediate ancestor leaving the registry without retaining that ancestor's runtime", and `ownedChildren` holds Session ids rather than Agent references "because one Session has at most one live Activation".
- Edge cases / failure handling: `requireLocalActivation` throws `NOT_CONTINUABLE` when a follow-up is addressed to an external execution; `captureLocalResult` returns `stopReason: 'error'` if a structured capture was requested but the child finished without one; a slot is released in the `finally` of a failed materialization; `announced` distinguishes a child the caller was told does not exist (rolled back before first acceptance) from one that owes the parent a settlement account.
- Surprising: `failureAt` is a *sequence number*, not a boolean — that is what lets a later committed turn ending supersede an earlier failure without a race. And a non-empty `ownedChildren` blocks settlement: the parent cannot finish while a grandchild is still owned.

### packages/subagent/subagent/src/types.ts
- Purpose: the published contract — `SubagentProvider`, `SubagentStartRequest`, `SubagentResult`, `SubagentRun`, `SubagentActivation`, and the lifecycle payloads.
- Key abstractions: `SubagentStopReasonMap` (a merge-extensible map, `completed|aborted|error|max-tokens|refusal`); `SubagentCapabilities` (`agentOptions|agentPreset|outputSchema|depthLimit`); `ContinuableCreateRequest`/`ContinuableCreateSpec`.
- Data flow: every provider implements `SubagentProvider`; the manager consumes `SubagentRun`.
- Non-obvious design decisions: the stop-reason vocabulary is a *merge-extensible map* so a backend can add a variant without changing the union, and the known cases mirror the harness turn-end vocabulary so the tool layer can map a non-`completed` result to an `isError` tool result. `ContinuableCreateSpec` is explicitly "DATA, never a capability" — it carries no Agent, handle, prompt, result, or disposal operation, because the manager owns the child's whole life after preparation.
- Edge cases / failure handling: `SubagentResult.diagnostic` is bounded to 4096 UTF-8 bytes and must carry no tool inputs, file contents, environment values, credentials, or raw protocol payloads.
- Surprising: `inheritsParentContext` is documented as "descriptive, not a service-validated start capability" — it only changes the model-facing WORDING, which is a much weaker promise than it sounds.

### packages/subagent/subagent/src/child-agent.ts
- Purpose: shared in-process child composition — depth budget, durable session metadata, resolved child `AgentOptions`, the delegated policy seed, and the scoped setup.
- Key abstractions: `resolveChildDepth`, `parentAgentOptionsForDelegation`, `resolveChildAgentOptions`, `childSessionMeta`, `applyChildComposition`, `captureDelegatedPolicyOverrides`, `appendDelegatedPolicyOverrides`, `SUBAGENT_DELEGATION_CONTEXT`.
- Data flow: `resolveChildAgentOptions` merges the parent's *latest logged request* provider/model/effort (not its creation options) with the request's overrides, and stamps `subagentDepth`. `captureDelegatedPolicyOverrides` reads the parent's permission preset, sandbox override, and approval capability SYNCHRONOUSLY; `appendDelegatedPolicyOverrides` writes them onto the child's own log as `sandbox/mode` / `approval/policy` / `permission/preset` events with `source: 'delegation'`.
- Non-obvious design decisions: **changing the route without naming an effort clears the parent's route-owned effort** so the selected model resolves its own default (line 116-118). The child's approval policy is pinned to `'never'` REGARDLESS of the parent's own policy — "a delegated child acts only within the sandbox scope fixed at delegation, so its asks are rejected deterministically". The delegation-scope statement is injected as a *runtime-context contribution*, not a system-prompt section, "so the deployment's system prompt stays uniform across parents and children".
- Edge cases / failure handling: `applyChildComposition` throws `PRESET_UNAVAILABLE` when an independent preset is selected without the preset service; a preset selection is rejected for a provider that inherits parent context.
- Surprising: the injected text is EXACTLY the scope note the harness itself uses ("operations that require approval are rejected automatically… state the limitation in your reply so the delegating agent can handle it") — the same contract, learned from the same source.

### packages/subagent/subagent/src/descriptor.ts
- Purpose: the durable `subagent/descriptor` session event — the child's identity, mode, and resumable composition.
- Key abstractions: `SUBAGENT_DESCRIPTOR_VERSION = 3`; `OneShotSubagentDescriptorData` vs `ContinuableSubagentDescriptorData`; `snapshotSubagentDescriptor` / `foldSubagentDescriptor`.
- Data flow: the manager appends the descriptor inside the child's initial turn; cold resume folds it back out of the child's own event suffix to reconstruct the child's provider/model/effort/persona/toolFilter.
- Non-obvious design decisions: the descriptor deliberately SNAPSHOTS explicit fields rather than the merge-extensible `AgentOptions` object — "an unrelated extension value cannot make continuation fail merely because it is not JSON, and later composition inputs require a deliberate version change". It omits `subagentDepth` (the persisted header is the monotone floor) and `outputSchema` (that is one activation's result contract, not durable composition). The parser is a strict closed-schema validator: an unknown field throws.
- Edge cases / failure handling: a payload with a different `version` folds to `undefined` (the child cannot be classified by this runtime) rather than throwing; a current-version payload that violates the schema throws, because damage should be loud.
- Surprising: `foldSubagentDescriptor` takes the FIRST descriptor event — "the establishing provider appends exactly one, so a later same-type event cannot rewrite the declared composition".

### packages/subagent/subagent/src/structured.ts
- Purpose: the child-scoped structured-output tool, its prompt instruction, its terminal guard, and the authoritative result capture.
- Key abstractions: `STRUCTURED_OUTPUT_TOOL = 'structured_output'`; `STRUCTURED_OUTPUT_INSTRUCTION`; `attachStructuredRuntime(childCtx, schema, canComplete)` returning a `StructuredAttachment`.
- Data flow: the tool validates the arguments against the schema, throws `ToolArgsError` on a violation (so the model retries in-turn), stages the value keyed by the `ToolExecution` object, calls `exec.concludeTurn()`, and the authoritative `tools/result` notification commits it.
- Non-obvious design decisions: the capture is a **TWO-PHASE COMMIT** — the value is staged at execute time and only committed when the authoritative `tools/result` arrives, because a later transformable waterfall may still turn the success into an error. The staging key is the `ToolExecution` IDENTITY, not the adapter call id, because "adapter call ids may repeat across steps, but another execution can never reach this Map entry". The terminal guard is installed as a tool GUARD (deny/abstain, never allow), so a later prepended listener cannot resurrect dispatch.
- Edge cases / failure handling: a failed result discards the capture and REOPENS input (`acceptsInput()` becomes true again); a committed capture keeps input closed; a nested PTC (`run_code`) capture is held until the enclosing execution commits.
- Surprising: "a clean finish without a capture is an immediate error to the parent — deliberately NO re-prompt" — the structured contract does not get a second chance.

### packages/subagent/subagent/src/depth.ts
- Purpose: delegation-depth accounting — the recursion budget a parent passes to its children.
- Key abstractions: `delegationDepthOf(agent)` and `assertSubagentMaxDepth(maxDepth)`.
- Data flow: `resolveChildDepth` computes `delegationDepthOf(parent) + 1` and compares it with the request's cap.
- Non-obvious design decisions: the persisted session header is a **monotone FLOOR** — runtime `AgentOptions.subagentDepth` may DEEPEN the count but never lower it, because "a resumed child arrives with fresh options, and counting it from zero would let it delegate as if it were top-level". The runtime value is validated as a non-negative safe integer (with `-0` explicitly rejected).
- Edge cases / failure handling: an invalid runtime depth throws `TypeError`; a computed depth outside the safe-integer range throws `RangeError`.
- Surprising: `Object.is(runtime, -0)` is checked explicitly — `-0` passes `runtime < 0` and would be stored as a depth of zero in some serializations.

### packages/subagent/subagent/src/lifecycle.ts
- Purpose: lifecycle-edge publication and the derivation of a run's terminal stop reason.
- Key abstractions: `ActivationObserver` (`start`/`settle`), `LifecycleEmitter`, `createLifecycleEmitter`, `createActivationObserver`, `epochStopReason(events)`.
- Data flow: the manager calls `observer.start(agent)` once the epoch is resident and `observer.settle(result)` after disposal; the emitter dispatches `subagent/start` / `subagent/end` through the scoped carrier keyed by the delegating parent.
- Non-obvious design decisions: every listener is independently CONTAINED — a synchronous throw or a rejected returned promise is logged without starving peer listeners, changing the run, or breaking a disposer-fired `provider-removed` event. `epochStopReason` reads the child's own log via `foldConsumedWork`, because "teardown succeeding says nothing about whether the model errored, hit its token ceiling, or was cancelled, so deriving the reason from disposal would report failed work as completed". A recorded failure still beats a cancellation.
- Edge cases / failure handling: a merge-extensible `TurnEndReason` variant that the runtime cannot name maps to `'error'`, never to success ("treating an unnameable reason as success would report failed work as completed"). A pre-step rejection (`blocked`) maps to `'refusal', because the work was declined, not done.
- Surprising: the emitter takes the carrier from the *service instance* because "a narrowed stand-in would silently change scope filtering".

### packages/subagent/subagent/src/catalog.ts
- Purpose: the parent-owned durable catalog of direct children, and its chunked projection.
- Key abstractions: `SubagentCatalogEvent` (versions 0/1/2: local modes, then unknown mode, then external); `subagentCatalogProjectionDefinition` (stateVersion 6); `establishCatalogChild` / `establishExternalCatalogChild`.
- Data flow: a successful local creation appends `subagent/catalog` to the PARENT's Session; the projection folds those into `SubagentCatalogEntry[]` for `listChildren`.
- Non-obvious design decisions: the catalog is stored on the parent, not on the child, so discovery is a single projection read and never loads a child Agent. The payload is versioned so old readers keep working: v0 records local modes, v1 adds `mode: 'unknown'` (a child whose descriptor is unavailable stays visible without claiming continuation support), v2 records external executions. The projection uses the shared `appendChunkedList` so a long-lived parent's catalog does not grow unboundedly.
- Edge cases / failure handling: the projection ignores events below `inheritedEventCount` (a fork's inherited facts are not this parent's children).
- Surprising: an external execution appends a catalog fact ONLY with `delivery: 'parent'` — a caller-owned external run keeps its caller's own membership records.

### packages/subagent/subagent/src/projection.ts
- Purpose: two pure session projections — the child's identity (mode/label) and its active-turn timing.
- Key abstractions: `subagentIdentityProjectionDefinition` (key `subagent`, stateVersion 2) and `subagentTimingProjectionDefinition` (key `subagentTiming`, stateVersion 3).
- Data flow: both fold the child's own `subagent/descriptor` event; the timing projection additionally folds `turn/start` and `turn/end`.
- Non-obvious design decisions: EVERY descriptor RESETS the timing state, because a fork seed may contain an ancestor's descriptor and completed turns — "the healthy catalog admits only a child with exactly one descriptor in its own suffix, making the final reset the child's authoritative timing origin". The identity's no-value state is the serializable `null` arm, never `undefined`, "so every registry read and push frame survives JSON.stringify losslessly, where an undefined field would be dropped and a stale identity would survive on the receiving side". A malformed payload folds to `null` rather than throwing — "a projection fold must never throw, so damage folds to no value".
- Edge cases / failure handling: `settledMs` accumulates `Math.max(0, event.time - active.since)` so a reversed clock boundary never subtracts.
- Surprising: the identity projection carries the descriptor's `seq` so a consumer can prove the identity came from the child's OWN suffix (`session.isOwnSeq(seq)`) rather than a fork seed's replayed ancestor descriptor.

### packages/subagent/subagent/src/projection-types.ts
- Purpose: the client-safe projection vocabulary — `SubagentCatalogEntry`, `SubagentTimingProjection`, `SubagentIdentityProjection`.
- Key abstractions: three `SessionProjectionMap` entries (`subagentCatalog`, `subagentTiming`, `subagent`).
- Data flow: the browser consumes these; the server publishes them.
- Non-obvious design decisions: the `subagent` entry is `SubagentIdentityProjection | null` and is deliberately non-optional — "the entry itself stays non-optional" so a consumer cannot mistake "no projection" for "no identity".
- Edge cases / failure handling: the three causes of `null` (missing, malformed, unrecognized version) are deliberately undistinguished — the consumer only needs to know there is no valid identity.
- Surprising: n/a.

### packages/subagent/subagent/src/list-children.ts
- Purpose: direct-child and recursive descendant discovery from the parent-owned catalogs.
- Key abstractions: `listChildren(ctx, parentSessionId, signal)` and `listDescendants(ctx, rootSessionId, signal)` returning `SubagentDescendantListEntry[]`.
- Data flow: each catalog is read through a live-preferred `SessionObservation` that is RELEASED before the next branch; the descendant walk is an explicit stack that visits each catalog once.
- Non-obvious design decisions: no Agent is loaded or resumed by either path — "neither path loads or resumes a child Agent". External entries are leaves and require no child Session at all. A branch whose catalog cannot be read produces a DIAGNOSTIC row and stops only that branch, while a ROOT read failure rejects the whole listing.
- Edge cases / failure handling: `SESSION_QUERY_CORRUPT_SESSION` / `SESSION_QUERY_SOURCE_CONFLICT` map to the `corrupt` diagnostic reason; anything else is `unavailable`; an unknown child mode yields an `unsupported` diagnostic but its catalog is still traversed. Cancellation is checked around every read.
- Surprising: `activity` is derived from `sessions.get(entry.id) === undefined ? 'inactive' : 'running'` — a child that is not in the live Session store is reported inactive even though the durable catalog still lists it.

### packages/subagent/subagent/src/archive-admission.ts
- Purpose: the `subagent` family of the Workspace registry's archive admission — which descendants are still inside a turn, and how they stop.
- Key abstractions: `installSubagentArchiveAdmission(ctx)` registering `workspace/session-activity` and `workspace/session-stop` listeners.
- Data flow: `runningDescendants` walks the durable lineage (`parentSession` + `origin === 'subagent'`) from the asked Session, at any depth; `workspace/session-stop` cancels each running descendant with the parent cause.
- Non-obvious design decisions: a FORK shares the lineage field but NOT the origin, "so it never holds its source" — a fork is an independent conversation, not a child to stop. The lineage is read as data with a `visited` set, so a damaged header chain that loops is visited once. The label comes from the child's descriptor through a live Session observation; without the query service the child is named by id alone.
- Edge cases / failure handling: one child refusing its cancel is logged and the siblings still stop. A damaged descriptor is "data damage in the child; the report still names the child".
- Surprising: the `subagent` family is merged into the workspace's `SessionActivityKindMap` — the seam answers a question a different service owns.

### packages/subagent/subagent/src/continuation-messages.ts
- Purpose: the model-visible messages owned by continuable-subagent orchestration — adjacent-Agent relays, the return guidance, and the settlement notice.
- Key abstractions: `AgentMessageSource` (`kind: 'agent-message'`, `form: 'relay'`) vs `SubagentSettledMessageSource` (`kind: 'subagent-settled'`, `form: 'notice'`); `createAgentMessage`, `withContinuableReturnGuidance`, `createSettlementMessage`.
- Data flow: `createAgentMessage` prepends `Agent <sender-id> sent a message: ` to the content; `createSettlementMessage` composes the summary line, the closing text, the structured result, and the diagnostic into ONE user-role message.
- Non-obvious design decisions: the two source kinds are deliberately DIFFERENT — "an Agent message is content the sender chose, while this message is the manager stating what became of the child, and a transcript that merged them would credit the child with words it never wrote". The settlement notice keeps only TEXT blocks from the child's output ("Parent providers receive this notice as a user message and may reject nontext assistant blocks"), and the full output survives for SDK/UI consumers. The return guidance tells the child its parent's id and that the parent "shares your workspace but does not automatically receive your transcript, tool output, or reasoning".
- Edge cases / failure handling: an empty closing text is reported as "It left no closing message."; an unnameable stop reason is reported as "ended abnormally (...) before it finished" rather than as success.
- Surprising: the settlement summary is the one place the seam states its own semantics in the parent's own task vocabulary ("Background subagent <id> finished and will do no further work unless you send it more.").

### packages/subagent/subagent/src/assistant-output.ts
- Purpose: the canonical selection of a child's final assistant output, shared by backend run results and `subagent/end.lastAssistantMessage`.
- Key abstractions: `AssistantOutputFold` (incremental) and `finalAssistantOutput(events)` (one-shot).
- Data flow: session-event backends `push()` each event; transports without session events (ACP content chunks) `pushText()` raw text into the same streamed fallback.
- Non-obvious design decisions: the rule is "the LAST non-empty assistant message"; an empty-content message records usage only and must not replace earlier output. Selection is INDEPENDENT of the stop reason — a `max-tokens` run still returns its last complete message.
- Edge cases / failure handling: the fallback is the accumulated assistant TEXT stream; reasoning and tool-result content never enter it. With neither, the result is `undefined` and the caller substitutes `[]`.
- Surprising: the file carries a TODO naming the exact optimization (scan backward with early exit) if a long continuable epoch ever profiles hot here — a perf concern written down instead of guessed at.

### packages/subagent/subagent/src/internal.ts
- Purpose: the host-adapter seam — the standard adjacent-Agent messaging tool marker and the Queue/Steer delivery adapters, kept out of the public Service Definition.
- Key abstractions: `adjacentAgentSendMessageTool` (a `Symbol.for`), `markAdjacentAgentSendMessageTool` / `isAdjacentAgentSendMessageTool`, `deliverSubagentPrompt` (a `Symbol.for`), `queueHostSubagentPrompt` / `steerHostSubagentPrompt`.
- Data flow: the `send_message` tool definition is marked with the symbol; the manager checks the marker to decide whether to append the continuable return guidance.
- Non-obvious design decisions: the marker is a SYMBOL on the definition, so the tool's model-visible schema is unchanged — "the process-stable identity carried only by the standard adjacent-Agent messaging tool". The delivery adapters go through a symbol-keyed private method on the runtime, "so host adapters can preserve their own source descriptors without widening the public Service Definition or impersonating an Agent sender".
- Edge cases / failure handling: n/a.
- Surprising: `Symbol.for` (global registry) rather than `Symbol()`, because the bundled runtime entry and this unbundled internal subpath must agree.

### packages/subagent/subagent/src/control-types.ts
- Purpose: the client-safe catalog rows, browser continuation requests, receipts, and the stable Remote failure codes.
- Key abstractions: `SubagentPromptRequest` / `SubagentPromptReceipt` / `SubagentInterruptReceipt`; `SubagentListEntry` (child or diagnostic); `SubagentAddress`; the `RemoteErrorDetailsMap` entries.
- Data flow: the browser sends `prompt`; the host answers with a `messageId` or one of the declared `subagent/*` errors.
- Non-obvious design decisions: `SubagentPromptRequestId` is branded as `session-request-id` — the SAME vocabulary as an ordinary Session prompt, spelled locally because the Session Controller depends on this package (so the import would be circular). The `delivery` discriminator (`queue` | `steer`) is part of the request, and the `mode: 'continuable'` literal is a "required discriminator retained from the browser control address".
- Edge cases / failure handling: the failure vocabulary is closed and each code has a declared detail shape — `subagent/invalid-time-zone`, `subagent/parent-unavailable`, `subagent/not-resumable`, `subagent/unauthorized`, `subagent/attachment-invalid`, `subagent/delivery-unavailable`.
- Surprising: the `activity` field of a catalog row is documented as NOT encoding a durable outcome — "it does not encode a durable outcome or guarantee continuation delivery".

### packages/subagent/subagent/src/control.ts
- Purpose: browser-request validation and the mapping from internal failures to stable public codes.
- Key abstractions: `validateControlRequest(method, payload)` (Zod) and `rejectPrompt(error, childSessionId, signal)`.
- Data flow: `SubagentRuntime.prompt` validates, then delivers, and wraps any failure through `rejectPrompt`.
- Non-obvious design decisions: the mapping is by INTERNAL code, not by exception type: `MODEL_DOES_NOT_SUPPORT_IMAGES` → `attachment-invalid`; `NOT_RESUMABLE` → `not-resumable`; `UNAUTHORIZED` → `unauthorized`; and `DRAINING`/`ACTIVATION_CLOSING`/`ACTIVATION_LIMIT_REACHED`/`CONTINUATION_UNAVAILABLE`/`PERSISTENCE_UNAVAILABLE` all collapse to ONE `delivery-unavailable` ("subagent follow-up is temporarily unavailable"). "A code outside the admission vocabulary is not the caller's move to make" → `gateway/internal`.
- Edge cases / failure handling: a cancellation is checked FIRST, so a cancelled delivery is `gateway/cancelled` rather than a failure.
- Surprising: the payload schemas are stricter than the generated branded-string codecs — the file exists precisely to add the strictness.

### packages/subagent/subagent/src/out-of-process.ts
- Purpose: the shared vocabulary every out-of-process backend composes — the no-capabilities advertisement, cwd validation, the never-reject result settlement, and the run handle.
- Key abstractions: `NO_START_CAPABILITIES` (frozen), `assertPositiveFinite`, `assertUsableCwd`, `settleRunResult(parts)`, `subprocessRunHandle(parts)`.
- Data flow: a provider calls `settleRunResult` to produce the `SubagentResult` and `subprocessRunHandle` to publish the `SubagentRun`.
- Non-obvious design decisions: `result` NEVER REJECTS after publication — a transport failure is FLATTENED to `stopReason: 'error'` through a contained diagnostic sink. `NO_START_CAPABILITIES` exists so an out-of-process child is REJECTED for a capability it cannot honor, "never accepted-then-ignored". `assertUsableCwd` probes the search permission (`accessSync(path, X_OK)`), because "statSync().isDirectory() is true for a mode-600 directory, but a subprocess cwd needs X_OK or spawn fails EACCES".
- Edge cases / failure handling: the diagnostic is truncated to 4096 UTF-8 bytes WITHOUT splitting a multi-byte sequence (the code walks back over continuation bytes). The abort listener is removed on EVERY settlement path (`finally`).
- Surprising: `subprocessRunHandle.dispose()` removes the abort listener, settles local cancellation (there is no assumption the child cooperates), and only then awaits the backend's teardown to actual exit — a three-step order that is easy to get wrong.

### packages/subagent/subagent/src/error.ts
- Purpose: the single typed failure class for the seam.
- Key abstractions: `SubagentError extends HarnessError` with a `code` string.
- Data flow: every service and manager failure is a `SubagentError` with one of the declared codes.
- Non-obvious design decisions: it extends `HarnessError` (not `Error`), so a subagent failure participates in the harness-wide error taxonomy — the same taxonomy the tool layer reads to decide `isError`.
- Edge cases / failure handling: `ErrorOptions` (the `cause` chain) is passed through, which is how the ACP/Codex/Claude backends keep the original failure on the chain while presenting a safe message.
- Surprising: n/a.

### packages/subagent/subagent/src/client.ts
- Purpose: the browser-safe surface — the control types and the three projection view types.
- Key abstractions: a pure `export type *` barrel.
- Data flow: the Web UI imports `./client` and never the service.
- Non-obvious design decisions: it is a TYPE-only module, so it costs the browser bundle nothing at runtime.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/activation-policy.spec.ts
- Purpose: proves the delegation policy is recorded on the CHILD's log before publication (sandbox override + `approval/policy: never` + the parent's Auto identity).
- Key abstractions: real `SandboxPolicyService`, `SandboxedFileSystem`, `ToolFs`, `ApprovalService`, and a `MockAdapter`.
- Data flow: appends `permission/preset` to the parent, sets the sandbox mode, starts a prepared activation, then asserts the child's events at seq 1..3.
- Non-obvious design decisions: the test asserts the EVENT ORDER (`sandbox/mode`, `approval/policy`, `permission/preset`) — the order is the contract, because a later event wins.
- Edge cases / failure handling: a read-only denial in the child proves the inherited sandbox mode actually binds.
- Surprising: the test explicitly shows the parent's `permission/preset` appearing TWICE when a fork seed is involved — "fresh policy wins stale seed state" is asserted, not assumed.

### packages/subagent/subagent/tests/activation-presets.spec.ts
- Purpose: proves a child inherits its parent's preset composition (tools and prompt sections) and follows a parent that switches preset.
- Key abstractions: the real `AgentPresets` registry loaded through the Cordis `Loader` + `Include` plugin, with the fixture presets under `tests/fixtures/activation-presets`.
- Data flow: the suite loads a preset document, composes an agent, starts a child, and asserts on the SCHEMAS in the child's own model request.
- Non-obvious design decisions: "These assert the model-visible result — the schemas in the child's own request — rather than the join that produces it."
- Edge cases / failure handling: the "follows a parent that switched preset while blank" case proves the switch is not lost.
- Surprising: the fixture presets are `.cordis.yml` documents loaded through the real Loader, so the test exercises the production composition path.

### packages/subagent/subagent/tests/archive-admission.spec.ts
- Purpose: the Workspace archive-admission contract — reporting running descendants, cancelling them, and surviving the service's disposal.
- Key abstractions: a hand-written `LiveAgent` double that records its cancels and lets the test flip its status.
- Data flow: the suite calls `ctx.waterfall('workspace/session-activity', …)` and `ctx.parallel('workspace/session-stop', …)`.
- Non-obvious design decisions: the test creates child Sessions with `meta: { parentSession, origin: 'subagent' }` directly, so the lineage is exercised without a real delegation.
- Edge cases / failure handling: a looping damaged lineage is visited once; one child throwing on cancel does not stop its siblings.
- Surprising: n/a.

### packages/subagent/subagent/tests/assistant-output.spec.ts
- Purpose: pins the final-output selection rule and the incremental fold.
- Key abstractions: synthetic `SessionEvent`s cast to the event shape.
- Data flow: n/a — pure.
- Non-obvious design decisions: the suite proves that a reasoning-only message IS a non-empty message (content length, not text length, is the test) and that reasoning deltas never enter the text fallback.
- Edge cases / failure handling: n/a.
- Surprising: "treats textless assistant content as a non-empty message" — the rule is content length, not text length.

### packages/subagent/subagent/tests/catalog.spec.ts
- Purpose: the catalog projection's fold, chunk rollover, checkpoint restoration, and the external-membership arm.
- Key abstractions: `subagentCatalogProjectionDefinition` applied directly to synthetic event lists.
- Data flow: n/a — pure.
- Non-obvious design decisions: the suite proves the projection "changes only for new own facts" — inherited and unrelated events must not move the state.
- Edge cases / failure handling: chunk rollover preserves event order.
- Surprising: n/a.

### packages/subagent/subagent/tests/child-agent.spec.ts
- Purpose: pins the child's `AgentOptions` inheritance rules and the depth validation.
- Key abstractions: `resolveChildAgentOptions` and `resolveChildDepth` called directly with a hand-built parent.
- Data flow: n/a — pure.
- Non-obvious design decisions: the suite proves the parent's LATEST LOGGED REQUEST beats the creation-time options, and that changing the route CLEARS the inherited effort unless the request names one.
- Edge cases / failure handling: `-1`, `-0`, `0.5`, `NaN`, and `Infinity` are all rejected as runtime depths.
- Surprising: n/a.

### packages/subagent/subagent/tests/continuation-inheritance.spec.ts
- Purpose: the continuable-child counterpart of the policy-inheritance suite — the seed, the approval pin, and the cold-resume behaviour.
- Key abstractions: real JSONL persistence, `SubagentFork`/`SubagentSpawn`, `SandboxPolicyService`, `ApprovalService`.
- Data flow: starts children, then cold-resumes them and asserts the persisted snapshot is replayed rather than the parent re-captured.
- Non-obvious design decisions: the "cold-resumes on the persisted snapshot without re-capturing the parent" case pins that a resume must NOT re-read the parent's current policy — the child's effective policy is reconstructable from its own log alone.
- Edge cases / failure handling: a later child-side switch wins over the delegation snapshot.
- Surprising: n/a.

### packages/subagent/subagent/tests/continuation-messages-adapter.spec.ts
- Purpose: proves a reasoning-bearing child's settlement notice can still be replayed through the DeepSeek adapter's default Messages path.
- Key abstractions: a real local HTTP server emitting SSE (`dsh-llm-deepseek/tests/helpers`).
- Data flow: the parent's second request is served by the fixture and asserted to succeed.
- Non-obvious design decisions: this is an ADAPTER-level test living in the subagent package, because the settlement notice is the first place the parent's transcript carries a message whose content the adapter must normalize.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/continuation-messages.spec.ts
- Purpose: pins the exact content of the settlement notice.
- Key abstractions: `createSettlementMessage` called with synthetic `SubagentResult`s.
- Data flow: n/a — pure.
- Non-obvious design decisions: the suite asserts the notice preserves text block ORDER and BYTES around omitted reasoning and tool-call blocks, and that the input array is NOT mutated (`structuredClone` comparison).
- Edge cases / failure handling: empty output, reasoning-only output, and empty text all produce the "It left no closing message." arm.
- Surprising: n/a.

### packages/subagent/subagent/tests/continuation-presets.spec.ts
- Purpose: independent spawn presets and the compatibility of persisted child compositions.
- Key abstractions: the real preset registry loaded through the Loader, JSONL persistence, and the descriptor snapshot helpers.
- Data flow: starts an independently-composed child, then cold-resumes it and asserts the restored composition.
- Non-obvious design decisions: the suite pins that an EXPLICIT SAME-AS-PARENT preset is still an independent selection ("restores an explicit same-as-parent selection after the parent switches and the provider unloads"), and that a fork whose own selection follows its descriptor stays on the parent composition.
- Edge cases / failure handling: a missing preset projection refuses independent restoration rather than falling back.
- Surprising: n/a.

### packages/subagent/subagent/tests/continuation.spec.ts
- Purpose: the largest suite in the shard (4,044 lines) — the whole continuable-child contract: capacity, admission, cold resume, ownership, teardown, settlement delivery, lifecycle observation, errors, and interrupt.
- Key abstractions: a `GatedAdapter` (a `MockAdapter` whose entries can hold a model call open until the test releases it), `holdChildLock` (occupies a child's `ChildLock` to place a deterministic race), `parkParent` (keeps the top-level parent out of the scripted corpus), and `managerState` (reaches into the private manager).
- Data flow: boots the FULL stack (`AgentLoop`, JSONL persistence, `SubagentSpawn`, `SubagentFork`, `SubagentControl`, `SubagentRuntime`) and drives real activations.
- Non-obvious design decisions: the suite reaches into private state (`managerState(ctx).resident`, `.locks`, `.ownerCtx`) to place races that cannot be scheduled otherwise — e.g. "occupy one child's lock so a settlement watcher that already observed quiescence waits behind the caller". The `GatedAdapter` is how a "tool call that is still running while the drain starts" is expressed.
- Edge cases / failure handling: the suite covers rollback at every boundary (before acceptance, between publication and acceptance, lifecycle publication failure), scoped teardown after an intermediate ancestor leaves the registry, the "no automatic replay for an accepted but unlogged message" limit, and every settlement-notice wording.
- Surprising: the suite pins that a settlement notice is delivered EVEN IF the child already sent a message — "the contract is unconditional precisely so the parent-side tool description can promise it".

### packages/subagent/subagent/tests/control.spec.ts
- Purpose: the browser-facing `prompt` and `interrupt` Remote methods, their validation, and every stable failure code.
- Key abstractions: a fake attachment store, the `deliverSubagentPrompt` internal symbol, and a test-only `PrincipalMap` entry (`test-guest`).
- Data flow: calls `ctx.subagents.prompt({...})` directly and asserts the receipt or the `RemoteError` code.
- Non-obvious design decisions: the suite asserts a NON-OWNER caller is recorded on the follow-up source and an OWNER is not — the durable attribution distinguishes the two.
- Edge cases / failure handling: base64 that is not canonical is refused WITHOUT touching the store; a text-only child model maps to `attachment-invalid`; a cancelled delivery answers `gateway/cancelled`.
- Surprising: n/a.

### packages/subagent/subagent/tests/external-activation-helpers.ts
- Purpose: registered parent fixtures for the external-backend suites.
- Key abstractions: a hand-built `Agent` object over a real `Session` with a `createInboxStub()` inbox.
- Data flow: `externalTestParent` registers the parent; `startExternalActivation` re-homes the request's parent onto the registered one.
- Non-obvious design decisions: the parent is a plain object literal implementing the `Agent` interface — no model is driven, so an external test costs nothing.
- Edge cases / failure handling: `cancel` honours `keepInbox`.
- Surprising: n/a.

### packages/subagent/subagent/tests/external-activation.spec.ts
- Purpose: external execution ownership, result delivery, and process cleanup.
- Key abstractions: a stub provider whose `start` returns a hand-built `SubagentRun`.
- Data flow: the suite starts external activations with `delivery: 'caller'` and `'parent'` and asserts the result, the disposal, and the catalog.
- Non-obvious design decisions: the "detaches accepted work from caller cancellation" case pins that the caller's signal stops owning the run after publication.
- Edge cases / failure handling: a backend whose result settles only when disposal begins is still cancellable; a non-Error backend cleanup rejection is contained and the execution result is retained.
- Surprising: n/a.

### packages/subagent/subagent/tests/external-lifecycle.spec.ts
- Purpose: external admission and resource ownership across parent lifetimes.
- Key abstractions: the same stub-provider shape.
- Data flow: the suite starts external children under two different parents and drains one.
- Non-obvious design decisions: "drains one parent's external child without cancelling another parent's pending startup" pins the per-parent scoping of `drainDescendants`.
- Edge cases / failure handling: a repeated external id across parents is rejected without disturbing its first execution.
- Surprising: n/a.

### packages/subagent/subagent/tests/fixtures/activation-presets/plugins/preset-tool.js
- Purpose: a preset row standing in for the agent-plane tool rows a real preset mounts.
- Key abstractions: a Cordis plugin with `name`, `inject`, and `apply` that registers one tool and one system-prompt section.
- Data flow: the preset documents point at it.
- Non-obvious design decisions: it is plain JavaScript and import-free "because the Loader resolves entry modules through Node's ESM resolver, which cannot see this workspace's TypeScript sources."
- Edge cases / failure handling: n/a.
- Surprising: a test fixture that has to be JS, not TS, because of how the production Loader resolves plugin entries.

### packages/subagent/subagent/tests/fixtures/activation-presets/presets/coding/agent.cordis.yml
- Purpose: the "coding" preset document — one agent-plane row mounting the `preset_only` tool.
- Key abstractions: a Cordis preset YAML with an `id`, a `name` (a relative path to the plugin), and a `config`.
- Data flow: loaded by the preset registry through the Loader.
- Non-obvious design decisions: the comment states the intent — "the model-facing row lives here, not in the host".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/fixtures/activation-presets/presets/reviewing/agent.cordis.yml
- Purpose: a second preset so a preset SWITCH is a real switch.
- Key abstractions: same shape as the coding preset, mounting `reviewing_only`.
- Data flow: loaded by the same registry.
- Non-obvious design decisions: the comment says "so a switch is a real switch: the tool a joined child sees has to change with it" — the fixture exists to make the switch observable.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/list-children.spec.ts
- Purpose: `listChildren` and `listDescendants` — the discovery surface, including a migrated parent with V3 files and >1,000 unrelated Sessions.
- Key abstractions: real JSONL persistence (with `generationLogPath` from the JSONL package), `TestSessionQuery`, and the spawn/fork providers.
- Data flow: the suite writes parent catalogs, then reads them back through the real projection.
- Non-obvious design decisions: the suite proves the listing "bounds chunk growth and ignores more than 1,000 unrelated Sessions" — discovery must not enumerate the Session store.
- Edge cases / failure handling: a corrupt live catalog is reported as `corrupt` and the siblings continue; a missing child is `unavailable`; a root read failure rejects the whole listing.
- Surprising: the suite asserts that an ordinary Session FORK and its cataloged children are omitted from the source Session's listing — a fork is not a delegation.

### packages/subagent/subagent/tests/local-activation.ts
- Purpose: local backend fixtures over the production activation lifecycle.
- Key abstractions: `mountLocalActivations` (isolated JSONL persistence with `onTestFinished` cleanup), `startTestActivation`, `startPreparedActivation`.
- Data flow: `startPreparedActivation` registers a temporary provider whose `prepareContinuable` returns a caller-supplied seed, then unregisters it in a `finally`.
- Non-obvious design decisions: the temporary provider's `agentPreset` capability is set to `prepared.seed === undefined` — i.e. a SEEDED child advertises parent-context inheritance, which is exactly the contract the fork backend uses.
- Edge cases / failure handling: cleanup removes the temp root after the context reaches quiescence.
- Surprising: the aliasing `{ ...activation, id: activation.childId, localAgent: ... }` gives the test both names for the same thing.

### packages/subagent/subagent/tests/manager-internals.ts
- Purpose: package-private access to the manager's live state, for deterministic race placement.
- Key abstractions: `subagentManager(ctx)`, `managerState(ctx)` (`resident`, `locks`, `ownerCtx`), `dropActivation(ctx, childId)`.
- Data flow: n/a.
- Non-obvious design decisions: `dropActivation` removes ONLY the map entry and leaves the Agent live — that is how a registry-collision case is produced.
- Edge cases / failure handling: n/a.
- Surprising: this is the seam's own "reach into the private state" escape hatch, and it is small enough to be trusted.

### packages/subagent/subagent/tests/out-of-process.spec.ts
- Purpose: the shared out-of-process vocabulary — the frozen capability set, the cwd probe, the never-reject settlement, and the idempotent handle.
- Key abstractions: the real filesystem for the cwd cases.
- Data flow: n/a — unit level.
- Non-obvious design decisions: the POSIX "no search permission" case is `skipIf(process.platform === 'win32')` with an explicit comment about Windows ACLs — the platform difference is documented rather than papered over.
- Edge cases / failure handling: the abort listener is proven removed at settlement; `dispose()` returns the SAME promise on a second call.
- Surprising: n/a.

### packages/subagent/subagent/tests/parent-result.spec.ts
- Purpose: parent result delivery when the child has NO `send_message` tool.
- Key abstractions: the real spawn provider and the real `SubagentControl` plugin (mounted or not).
- Data flow: the parent receives the child's closing answer through the settlement notice.
- Non-obvious design decisions: the suite is parameterized over `send_message` being ABSENT and merely UNUSED — the promise must hold in both.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/parked-wait.spec.ts
- Purpose: host completion racing around idle local children whose inbox still holds preserved input.
- Key abstractions: a local provider fixture with a scripted adapter, and `managerState` to observe residency.
- Data flow: the suite starts children, parks messages in their inboxes, and checks that the host's wait does not return while a child is genuinely idle-but-resident.
- Non-obvious design decisions: this is the suite that pins the README's stated limit — "Pending injected context retains an Activation … Host completion joins active work, pending child creation, and resource cleanup, but does not wait for a subtree containing only idle parked inboxes".
- Edge cases / failure handling: a revived sibling after another parked child finishes maintenance is rechecked.
- Surprising: n/a.

### packages/subagent/subagent/tests/persistence-helpers.ts
- Purpose: handle-based session-persistence helpers for the suites.
- Key abstractions: `loadStoredSession(persistence, id)` and `seedStoredSession(persistence, header, events, inheritedEventCount?)`.
- Data flow: `loadStoredSession` opens a read handle, reads the whole log, and closes it in a `finally`.
- Non-obvious design decisions: the helpers return `inheritedEventCount` alongside the events — the fork boundary is as important as the events themselves.
- Edge cases / failure handling: the handle is always closed, even when the read throws.
- Surprising: n/a.

### packages/subagent/subagent/tests/run-settlement.spec.ts
- Purpose: the diagnostic byte-limit and truncation rules, and the cancellation-wins rule.
- Key abstractions: `settleRunResult` called directly.
- Data flow: n/a — unit level.
- Non-obvious design decisions: the oversized text is `'权限'.repeat(4096)` — a MULTIBYTE string — so the test proves the truncation does not split a UTF-8 sequence and never produces `�`.
- Edge cases / failure handling: a cancellation that lands after a successful attempt still yields `stopReason: 'aborted'` with the partial output.
- Surprising: n/a.

### packages/subagent/subagent/tests/schedule-tools.spec.ts
- Purpose: a preset-mounted Schedule tool reaching a delegated child, and the Host Schedule service REFUSING that child's own Session.
- Key abstractions: the real Schedule service, the storage domain, and a preset that mounts `tool-schedule`.
- Data flow: the child calls `schedule_create`; the service rejects with `subagent_session`.
- Non-obvious design decisions: this suite documents a hard boundary — the Session controller can never deliver a reminder into a delegated child's session, so the tool is refused rather than silently dropping the task.
- Edge cases / failure handling: the refusal must not store a task.
- Surprising: n/a.

### packages/subagent/subagent/tests/service.spec.ts
- Purpose: the service surface — provider registration, capability validation, lifecycle emission, descriptor parsing, and the error taxonomy.
- Key abstractions: a `StubProvider` with a counter and a captured request; `liveConfig` for the volatile settings.
- Data flow: registers providers, starts activations, and asserts the emitted `subagent/start` / `subagent/end` payloads.
- Non-obvious design decisions: the suite proves the lifecycle pair is scoped to the delegating parent ("keeps parent scope") and that a throwing `provider-added` listener rolls the registration back.
- Edge cases / failure handling: a lifecycle observer that throws synchronously or rejects asynchronously is CONTAINED; a provider that implements neither execution method is rejected at registration.
- Surprising: "mints distinct lifecycle identities when provider and child ids repeat" — the `runId` is a fresh UUID per epoch, so the pair is unambiguous even when the child id repeats.

### packages/subagent/subagent/tests/structured.spec.ts
- Purpose: the whole structured-output contract (1,003 lines) — capture, terminality, input closure, scoped registration, and the PTC nested case.
- Key abstractions: real `AgentLoop` with `toolMode: 'native' | 'ptc'`; a fake `ptcRuntime`; `defineContentToolFixture`/`RUN_CODE_NAME`.
- Data flow: starts a structured activation, drives tool calls through the real tool runtime, and asserts on the child's own `tools/result` events.
- Non-obvious design decisions: the suite pins "stops the turn after a successful capture — no extra model step is spent" (`exec.concludeTurn()`), and that a later PREPENDED pre-execute listener cannot resurrect dispatch after the capture (the guard composes monotonically). It also pins that a post-execute BLOCK on the capture call denies the capture, and that an accept-with-replacement still commits it.
- Edge cases / failure handling: reusing a failed execution's call id never promotes its discarded stage; a `structured_output` call from an agent WITHOUT a structured run is `UNKNOWN_TOOL`.
- Surprising: "a non-structured agent request keeps tools ABSENT when it had none (no `tools: []` materialized)" — the suite asserts the ABSENCE of a key, not just its value.

### packages/subagent/subagent/tests/test-session-query.ts
- Purpose: a minimal concrete `SessionQueryEngine` for the subagent suites.
- Key abstractions: overrides `searchSessions()`/`searchEvents()` to reject.
- Data flow: n/a.
- Non-obvious design decisions: the search faces throw rather than return empty, so a test that accidentally depends on search fails loudly.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tests/timing-projection.spec.ts
- Purpose: the timing and identity projections — reset at the descriptor, accumulation across turns, and the wire view.
- Key abstractions: `subagentTimingProjectionDefinition` applied to synthetic events.
- Data flow: n/a — pure.
- Non-obvious design decisions: the suite proves the projection "exposes an open turn start and never subtracts time for reversed boundaries".
- Edge cases / failure handling: completed PRE-descriptor turns are ignored; unrelated events are ignored.
- Surprising: n/a.

### packages/subagent/subagent/tests/working-directory-fixture.ts
- Purpose: a symbolic working-directory collaborator for orchestration tests.
- Key abstractions: a `Service` named `workingDirectory` that keeps a `WeakMap<Session, string>`.
- Data flow: `ensure`/`set` resolve relative paths against the session's current directory.
- Non-obvious design decisions: it deliberately models NO filesystem behaviour, "whose paths are symbolic and whose logs exclude context providers" — the suite only needs a directory identity.
- Edge cases / failure handling: `signal.throwIfAborted()` on every operation.
- Surprising: n/a.

### packages/subagent/subagent/tests/working-directory.spec.ts
- Purpose: the child's working directory — inheritance, independence from later parent changes, and rollback when the setup realm has no directory service.
- Key abstractions: real JSONL persistence, the real spawn and fork providers, `TestSessionQuery`.
- Data flow: the suite creates a nested directory tree and asserts each child's `cwd`.
- Non-obvious design decisions: a child-owned directory follows any inherited history and is INDEPENDENT of later parent changes — "Later directory changes in either agent are independent."
- Edge cases / failure handling: a child whose setup realm lacks the directory service is rolled back completely.
- Surprising: n/a.

### packages/subagent/subagent/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent`, v `0.2.1-rc.2`, public.
- Key abstractions: five export subpaths — `.`, `./internal`, `./client`, `./typert`, `./remote` — plus `./src/*`.
- Data flow: the loader imports `.`; hosts import `./remote`; the Web UI imports `./client`.
- Non-obvious design decisions: almost every capability is an OPTIONAL peer dependency (`peerDependenciesMeta`), so the seam composes with a bare `agents` service and gains continuable behaviour as services appear.
- Edge cases / failure handling: n/a.
- Surprising: the `files` list omits `lib/types/**/*.js` for the root entry but includes it for the subpaths — the packaging is hand-tuned per entry.

### packages/subagent/subagent/README.md
- Purpose: the English package reference — the seam contract, capacity semantics, presets, messaging, discovery, failure/recovery, and a full Model Experience section.
- Key abstractions: the standard README skeleton; the "Model Experience" section is split into "What the model sees" / "Token effect" / "KV Cache effect" per surface.
- Data flow: n/a.
- Non-obvious design decisions: the KV Cache effect of the settlement notice is stated explicitly ("Append-only in the parent: the notice follows its reusable request prefix. Reaching an idle parent starts one independent model request; reaching a busy one does not") — the README treats cache behaviour as part of the contract.
- Edge cases / failure handling: the "Known Limitations and Deferred Work" section names the real limits (sequential descendant reads, external children execute once, no durable parent mailbox, no replay of accepted-but-unlogged messages, process-local residency).
- Surprising: n/a.

### packages/subagent/subagent/README.zh.md
- Purpose: the Chinese translation of the package reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/README.i18n.yaml
- Purpose: EN/ZH section hashes for the package reference.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/locale/en.json
- Purpose: English plugin-card title ("subagent").
- Key abstractions: the `meta` object with only a `title`.
- Data flow: the host plugin list.
- Non-obvious design decisions: the English file carries a title but no description; the Chinese one has both.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/locale/zh.json
- Purpose: Chinese plugin-card metadata — "子智能体服务" / "管理子智能体后端，为任务委派提供统一接口。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent/tsconfig.json
- Purpose: TypeScript project config for the seam.
- Key abstractions: 20 project references, including the optional capability packages (sandbox-policy, user-approval, permission-presets, session-persistence, session-projection, session-query, workspace).
- Data flow: n/a.
- Non-obvious design decisions: the references list IS the capability list — a peer that is optional in `package.json` still needs a project reference for the type-only imports to resolve.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/src/index.ts
- Purpose: the model-facing delegation tool — one instance per provider, with context-sensitive wording, depth policy, preset selection, and optional child LLM selection.
- Key abstractions: `Config { provider, toolName, modelSelectionSettings, agentOptions, agentPreset, allowedAgentPresets, maxDepth }`; `providerWording(inheritsConversation)`; the two system-prompt contributions.
- Data flow: `apply(ctx, config, session?)` → `install(runtimeCtx, policy)` → `mount(provider)` → `defineTool({...})` → `ctx.tools.register`; the tool's `execute` resolves the child's route, prefights it against the live LLM adapter, then calls `ctx.subagents.startActivation({ delivery: 'parent' })` and returns `{ kind: 'activation', subagentId }`.
- Non-obvious design decisions: the tool DESCRIPTION is derived from `provider.inheritsParentContext` — a forked child gets "it does not see the current in-flight turn" wording so the model never restates context that does not exist. The tool exists exactly while its provider does: it mounts on `subagent/provider-added` and disposes on `subagent/provider-removed`, so load order and HMR cannot strand a dangling tool. The route is PREFLIGHTED against the live adapter before the child is created, and the provider is re-checked after the preflight ("subagent provider … changed while resolving the child LLM route; retry the delegation"). The depth notice is a RUNTIME-CONTEXT contribution, resolved again at each request, and it does not change the system prompt or the tool schemas.
- Edge cases / failure handling: a numeric `maxDepth` the provider cannot enforce FAILS THE MOUNT rather than the first delegation; `persona`/`toolFilter` in the tool config throw a migration error; an out-of-range `maxDepth` is rejected at load.
- Surprising: the shared guidance section lists the visible delegation tools by NAME ORDER and returns '' when the tool is hidden — "at most one short delegation paragraph per parent request, listing the tool names visible to that request."

### packages/subagent/tool-subagent/src/model-selection.ts
- Purpose: the child LLM route selection policy — request/config merging, the exact-route allowlist, and the live-adapter preflight.
- Key abstractions: `AllowedModelRoute`, `ModelSelectionPolicy`, `modelRouteKey`, `assertAllowedModelRoutes`, `requestedAgentOptions`, `assertAllowedModelSelection`, `preflightChildLlmRoute`.
- Data flow: the tool's `execute` merges the parent's options, the configured defaults, and the model's fields, then enforces the policy and preflights the route.
- Non-obvious design decisions: provider and model form ONE route and must be supplied together. "Changing the effective route without naming an effort uses the selected model's default effort" — so a route change CLEARS the configured route-owned effort. The allowlist is EXACT (provider + model), and pure inheritance is OUTSIDE the policy, "because no model-facing choice occurred". The route key uses a NUL separator so a provider/model pair cannot be forged by string concatenation.
- Edge cases / failure handling: an empty provider or model string is refused at the tool JSON boundary; a duplicate route in a settings document is refused at the durable boundary.
- Surprising: `assertAllowedModelRoutes` is an `asserts` function — it narrows the type at the boundary, so a caller cannot forget to validate.

### packages/subagent/tool-subagent/src/model-selection-state.ts
- Purpose: the durable per-session record of the model-selection opt-in.
- Key abstractions: the `subagent/model-selection-policy` session event; the `subagentModelSelectionPolicy` projection; `recordSubagentModelSelection` / `subagentModelSelectionPolicy`.
- Data flow: the policy is appended to the Session BEFORE its definition can reach a model request, then inherited by child Sessions.
- Non-obvious design decisions: the event is LOG-ONLY — it carries no `surfaceOp` and never enters model history. The projection is FIRST-WIN (`if (policy !== null || event.type !== …) return policy`) so the decision is recorded once and a later event cannot change it. The route list is copied on both read and write so the projection's array is never shared mutable state.
- Edge cases / failure handling: an invalid route list in a persisted event throws at the projection boundary; an empty list is refused ("requires at least one route").
- Surprising: the durable record is what makes the decision survive a settings change — "the recorded decision … unchanged by later settings edits".

### packages/subagent/tool-subagent/src/model-selection-settings.ts
- Purpose: the Host-owned opt-in setting for model-selectable delegation.
- Key abstractions: `SubagentModelSelectionConfig extends Service` (`ctx.subagentModelSelection`) with `enabled` and `allowedModels`, both `Volatile`.
- Data flow: `current()` is sampled when a new top-level Session is composed.
- Non-obvious design decisions: the shipped default is OFF (`enabled: z.boolean().default(false)`), and `current()` throws if `enabled` is true with an empty route list — a misconfiguration is loud rather than a silently useless feature.
- Edge cases / failure handling: the route list is re-validated on every read.
- Surprising: n/a.

### packages/subagent/tool-subagent/src/list-models.ts
- Purpose: the `list_subagent_models` discovery tool.
- Key abstractions: `registerListSubagentModels(ctx, policy)` registering a fixed tool name.
- Data flow: the tool lists providers, then a provider's advertised models, then one exact model's reasoning efforts.
- Non-obvious design decisions: an UNAUTHORIZED provider is rejected BEFORE its adapter catalog is called, and an exact model lookup must be allowed before it resolves the model's efforts. The description states that "Catalog membership is advisory: an adapter may accept an unlisted model id" — the tool does not pretend to be a complete catalogue.
- Edge cases / failure handling: `model` without `provider` is refused; an empty provider or model string is refused; a missing `llm` service is refused with a named message.
- Surprising: n/a.

### packages/subagent/tool-subagent/src/preset-selection.ts
- Purpose: the deployment-owned preset choice and the model-facing `agent_preset` allowlist.
- Key abstractions: `SubagentPresetSelection` with `configured`, `choices`, `description`, `validate(ctx)`, `assertProvider(provider)`, `resolve(request)`.
- Data flow: `validate` reads each configured preset's description from the registry so the tool's parameter description can list them; `resolve` applies the deployment default when the model makes no selection.
- Non-obvious design decisions: a preset selection is REFUSED for a provider that inherits the parent conversation ("independent selection" is meaningless there). The allowlist must include the configured default, and duplicates are refused at construction.
- Edge cases / failure handling: a model-supplied id that is not a string or not in the allowlist is refused with the allowed list in the message.
- Surprising: `validate` reads the preset documents but does NOT activate them — "This check does not activate candidate presets."

### packages/subagent/tool-subagent/tests/harness.ts
- Purpose: the shared test harness — context ownership, the tool call helper, and the model-selection setup agent.
- Key abstractions: `ownContext(ctx)`, `testToolSignal`, `setup(...)`, `callSubagent(...)`, `modelSelectionSetupAgent(...)`, `disposeSetupProvider(...)`.
- Data flow: builds a `Context` with the loop, the subagent runtime, and a scripted provider.
- Non-obvious design decisions: the harness imports the working-directory fixture from the SIBLING package (`../../subagent/tests/working-directory-fixture.ts`) — test fixtures are shared across packages by relative path.
- Edge cases / failure handling: `afterEach` disposes every owned context.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/scripted-provider.ts
- Purpose: a package-local scripted child boundary for deterministic tool tests.
- Key abstractions: a `SubagentProvider` whose `start` returns a fixed result.
- Data flow: the provider is registered under a test name and answers every activation.
- Non-obvious design decisions: the default capability set advertises `agentOptions`, `outputSchema`, and `depthLimit` but NOT `agentPreset` — so the preset tests must opt in explicitly.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/depth-context.spec.ts
- Purpose: the depth runtime-context notice, read through REAL prompt assembly.
- Key abstractions: `assembleContextFor` and `ctx.systemPrompt.assemble` to read the actual context parts.
- Data flow: n/a.
- Non-obvious design decisions: the test asserts "without changing system text or tools" — the notice must be a CONTEXT part, so it does not invalidate the cached system prefix.
- Edge cases / failure handling: every depth/cap combination is parameterized.
- Surprising: the exact wording is pinned, including "remaining levels 0".

### packages/subagent/tool-subagent/tests/scripted-provider.spec.ts
- Purpose: the scripted provider fixture's own contract.
- Key abstractions: a `fakeParent` and a `baseRequest`.
- Data flow: n/a.
- Non-obvious design decisions: the suite pins that the provider receives the RESOLVED request (with an absolute `cwd`).
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/preset-selection.spec.ts
- Purpose: the deployment configuration and the model-facing preset selection.
- Key abstractions: the real Loader + Include + AgentPresets, and the scripted provider.
- Data flow: the suite calls `callSubagent` with and without an `agent_preset` argument.
- Non-obvious design decisions: the suite pins that the model CANNOT override a configured default without an allowlist ("without this allowlist, the model cannot override the configured choice").
- Edge cases / failure handling: a preset that fails to activate rejects the selected preset when the child is composed.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/list-models.spec.ts
- Purpose: the `list_subagent_models` discovery tool's outputs and refusals.
- Key abstractions: a `CatalogAdapter` that advertises a model catalog.
- Data flow: the tool is called with a provider, with a provider+model, and with neither.
- Non-obvious design decisions: the tool's refusal messages name the ALLOWED providers so a model can correct itself.
- Edge cases / failure handling: an unauthorized provider is refused before the adapter is consulted.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/model-selection.spec.ts
- Purpose: the route merge rules, the exact-route policy, and the live-adapter preflight.
- Key abstractions: `MockAdapter` with a reasoning-effort catalog.
- Data flow: the suite calls the tool with provider/model/effort fields and asserts the resolved child options.
- Non-obvious design decisions: the suite pins that a route change without an effort clears the inherited effort, and that an effort-only request is allowed.
- Edge cases / failure handling: `assertAllowedModelRoutes` rejects malformed and duplicate entries.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/model-selection-settings.spec.ts
- Purpose: the default-off setting and the per-session decision.
- Key abstractions: `liveConfig` for the volatile settings, the scope helpers, and the policy projection.
- Data flow: the suite composes a Session and asserts the recorded policy event and the resulting tool schema.
- Non-obvious design decisions: a RESTORED Session without a recorded policy remains DISABLED, "including an explicitly empty restore" — the opt-in is per fresh Session, never inherited from the restored transcript.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/tests/tool-subagent.spec.ts
- Purpose: the delegation tool's own suite (811 lines) — registration lifecycle, activation requests, and result acknowledgement.
- Key abstractions: the real Loader, `MockAdapter`, JSONL persistence, and the spawn provider.
- Data flow: the suite calls the tool through the real tool runtime and inspects the persisted child session.
- Non-obvious design decisions: the suite pins that the tool's canonical result carries NO execution promise and no final output — "programmatic consumers that need to await results use the subagent service directly".
- Edge cases / failure handling: `TOOL_ABORTED_BEFORE_DISPATCH` is imported and asserted, so a cancelled tool call is distinguished from a failed one.
- Surprising: n/a.

### packages/subagent/tool-subagent/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-tool-subagent`, v `0.2.1-rc.2`.
- Key abstractions: two export subpaths — `.` and `./model-selection-settings`.
- Data flow: the settings subpath is loaded by the Host scope, not by the tool.
- Non-obvious design decisions: the settings service is a SEPARATE subpath so a deployment can compose the tool without the opt-in.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/README.md
- Purpose: the English reference for the delegation tool.
- Key abstractions: the standard skeleton with a config table and a detailed Model Experience section.
- Data flow: n/a.
- Non-obvious design decisions: the README states the KV-cache consequence of the fork restriction — "Shipped fork tools cannot select a child LLM route — they inherit the parent's provider and model to keep the copied conversation prefix eligible for KV Cache reuse."
- Edge cases / failure handling: the "Known Limitations" section names the depth cap as fixed per instance and the fork route restriction.
- Surprising: n/a.

### packages/subagent/tool-subagent/README.zh.md
- Purpose: the Chinese translation of the delegation tool reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/README.i18n.yaml
- Purpose: EN/ZH section hashes for the delegation tool README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/locale/en.json
- Purpose: English plugin-card title ("tool-subagent").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/locale/zh.json
- Purpose: Chinese plugin-card metadata — "子智能体委派工具" / "让 AI 将任务交给子智能体，并获取运行结果。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/locale/model-selection-settings/en.json
- Purpose: English plugin-card title for the settings subpath ("tool-subagent/model-selection-settings").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list, for the separately-loaded settings plugin.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/locale/model-selection-settings/zh.json
- Purpose: Chinese plugin-card title for the settings subpath ("子智能体模型选择设置").
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/tsconfig.json
- Purpose: TypeScript project config for the delegation tool.
- Key abstractions: references to `dsh-subagent`, `dsh-scope`, `dsh-session-projection`, `dsh-preset-registry`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent/tsdown.config.ts
- Purpose: the tsdown build config — two self-contained ESM entries, `dts: false`, `clean: false`.
- Key abstractions: the `entry(path)` helper.
- Data flow: the release build emits `lib/index.js` and `lib/model-selection-settings.js`.
- Non-obvious design decisions: the comment says the entries are built "so the package needs no private chunks" — a published package that must not leak a shared chunk into a consumer's bundler.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/src/index.ts
- Purpose: the globally named `send_message` and `interrupt_agent` tools — thin adapters over `ctx.subagents.sendMessage()` and `ctx.subagents.interrupt()`.
- Key abstractions: two `defineTool` registrations; `markAdjacentAgentSendMessageTool` on the `send_message` definition.
- Data flow: `send_message` → `ctx.subagents.sendMessage(exec.agent, targetId, content, { signal })` → returns `{ messageId }`; `interrupt_agent` → `ctx.subagents.interrupt(targetId, { kind: 'ancestor', agent: caller })` → returns `{ accepted: true }`.
- Non-obvious design decisions: the tools live apart from the provider-bound `tool-subagent` instances "so multiple delegation tools share one control API". They perform NO lifecycle routing of their own — residency, cold resume, and interrupt authorization belong to the service. The `interrupt_agent` description is explicit that it "returns without waiting for it to stop" and that "Subagents it started will keep running".
- Edge cases / failure handling: a call with no `exec.agent` throws a named error rather than acting without an authority.
- Surprising: `send_message` returns DELIVERY CONFIRMATION, not the agent's answer — and says so in the description.

### packages/subagent/tool-subagent-control/src/list-agents.ts
- Purpose: the `list_agents` discovery tool, in a SEPARATELY loadable plugin so a deployment can register delivery without discovery.
- Key abstractions: `list_agents` with a `scope` of `children` (default) or `descendants`.
- Data flow: `children` → `ctx.subagents.listChildren(parent.id, exec.signal)`; `descendants` → `ctx.subagents.listDescendants(...)`; each row is projected and the status refined through the live Agent registry.
- Key abstractions (2): the `ListAgentsEntry` union of child rows and diagnostic rows.
- Non-obvious design decisions: one-shot and external children are OMITTED from the output, "so the model never selects them" — they cannot accept `send_message`. The rendered text is one line per child (`<id> [<status>] — <label>`) and the `descendants` scope inserts ` parent=<id> depth=<n>` before the label dash.
- Edge cases / failure handling: diagnostics appear only in `descendants` scope; `(no subagents)` is the empty rendering.
- Surprising: the tool description tells the model "there is no need to keep checking its status" — the tool set is designed to suppress polling.

### packages/subagent/tool-subagent-control/tests/park-parent.ts
- Purpose: a shared helper that keeps the stand-in parent out of the scripted model corpus.
- Key abstractions: `parkParent(ctx, parent)` installing an `agent/pre-step` reject listener.
- Data flow: n/a.
- Non-obvious design decisions: the comment explains why — "Each child settlement wakes its parent, and these suites size their scripts for child turns only".
- Edge cases / failure handling: n/a.
- Surprising: the same pattern is duplicated in `packages/subagent/subagent/tests/continuation.spec.ts` — a small helper that got copied rather than shared.

### packages/subagent/tool-subagent-control/tests/test-session-query.ts
- Purpose: a minimal concrete `SessionQueryEngine` for the control-tool suites.
- Key abstractions: overrides `searchSessions()`/`searchEvents()` to reject.
- Data flow: n/a.
- Non-obvious design decisions: identical to the copy in the sibling `subagent` package — the two are separate files rather than one shared helper.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/tests/list-agents.spec.ts
- Purpose: the `list_agents` tool's projection, scoping, and status refinement.
- Key abstractions: a `GatedAdapter`; real JSONL persistence; the spawn provider.
- Data flow: the suite starts children and lists them through the tool.
- Non-obvious design decisions: the status comes from the LIVE Agent registry, so a persisted-but-not-loaded child is `inactive`.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/tests/tool-subagent-control.spec.ts
- Purpose: `send_message` and `interrupt_agent` end to end (492 lines).
- Key abstractions: real loop, persistence, spawn and fork providers, `MockAdapter` with a gated variant.
- Data flow: the suite calls the tools and inspects the persisted Sessions.
- Non-obvious design decisions: the suite pins the "interrupt stops only the CURRENT turn" semantics: queued messages stay parked until a later `send_message`, descendants keep running, and the child stays available for follow-ups.
- Edge cases / failure handling: self, sibling, stale, and non-ancestor callers get errored results.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-tool-subagent-control`, v `0.2.1-rc.2`.
- Key abstractions: two export subpaths — `.` (send/interrupt) and `./list-agents` (the separately loadable discovery tool).
- Data flow: n/a.
- Non-obvious design decisions: the list tool is a SEPARATE subpath so discovery is opt-in.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/README.md
- Purpose: the English reference for the three control tools.
- Key abstractions: the standard skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the README states the "Listing is a snapshot, not a delivery promise" limit, and that `interrupt_agent` performs the authoritative live-lineage check itself "so discovery staleness cannot grant authority".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/README.zh.md
- Purpose: the Chinese translation of the control tools reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/README.i18n.yaml
- Purpose: EN/ZH section hashes for the control tools README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/locale/en.json
- Purpose: English plugin-card title ("tool-subagent-control").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/locale/zh.json
- Purpose: Chinese plugin-card metadata — "子智能体控制工具" / "让 AI 向子智能体发送消息或中断其运行。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/locale/list-agents/en.json
- Purpose: English plugin-card title for the list-agents subpath ("tool-subagent-control/list-agents").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/locale/list-agents/zh.json
- Purpose: Chinese plugin-card title for the list-agents subpath ("子智能体列表工具").
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/tool-subagent-control/tsconfig.json
- Purpose: TypeScript project config for the control tools.
- Key abstractions: references to `dsh-subagent`, `dsh-llm`, `dsh-session`, `dsh-tools`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/src/index.ts
- Purpose: the in-process SPAWN backend — a fresh child Agent on the same Cordis context.
- Key abstractions: `SpawnInProcessProvider` advertising all four capabilities and `inheritsParentContext = false`.
- Data flow: `prepareContinuable()` returns `{}` (no seed); the manager then creates the child.
- Non-obvious design decisions: the provider injects ONLY `subagents` — "`tools` is deliberately not injected: the child factory already provides it during setup, and adding it here would unnecessarily change this provider's apply timing" (and therefore the delegation tool's position in the model-visible tool list).
- Edge cases / failure handling: n/a.
- Surprising: the whole provider is 20 lines; everything else is the manager's.

### packages/subagent/subagent-spawn-in-process/README.md
- Purpose: the English reference for the spawn backend.
- Key abstractions: the standard skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the KV-cache section states the child's request cache is INDEPENDENT of the parent's, and that "preset, generated-SDK, provider, or model changes establish a different child prefix".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/README.zh.md
- Purpose: the Chinese translation of the spawn backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/README.i18n.yaml
- Purpose: EN/ZH section hashes for the spawn backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-spawn-in-process`, v `0.2.1-rc.2`.
- Key abstractions: peer dependencies on `@deepseek-ai/dsh-subagent` and `@deepseek-ai/cordis` only.
- Data flow: n/a.
- Non-obvious design decisions: the dependency list is deliberately minimal — the backend is a provider, not a runtime.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/locale/en.json
- Purpose: English plugin-card title ("subagent-spawn-in-process").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/locale/zh.json
- Purpose: Chinese plugin-card metadata — "新建子智能体后端" / "在当前进程中新建子智能体，执行独立任务。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/tsconfig.json
- Purpose: TypeScript project config for the spawn backend.
- Key abstractions: references to `dsh-subagent` and the cordis vendor packages.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/tests/harness.ts
- Purpose: the shared harness for the spawn backend's e2e — the FULL real stack (DeepSeek adapter, real bash tool, the subagent tool bound to spawn).
- Key abstractions: `spawnHarness` and `waitForIdle`.
- Data flow: boots the real stack so a real parent can delegate to a real in-process child doing real filesystem work.
- Non-obvious design decisions: the harness deliberately mounts the REAL `LocalBashExecutor` and `ToolBash` — the e2e proves the child can actually touch the filesystem, not just talk.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/tests/spawn-in-process.e2e.ts
- Purpose: a KEY-GATED smoke for a real parent delegating filesystem work to a real child.
- Key abstractions: `spawnHarness`, `waitForIdle`; a temp working directory.
- Data flow: the parent prompts, the child runs a command, the parent reads the result.
- Non-obvious design decisions: it is gated on a real API key, so it never runs in an ordinary CI job.
- Edge cases / failure handling: `afterEach` disposes the context and removes the work directory.
- Surprising: n/a.

### packages/subagent/subagent-spawn-in-process/tests/subagent-spawn-in-process.spec.ts
- Purpose: the spawn backend's unit/integration suite (385 lines) against the real seam.
- Key abstractions: the real `SubagentRuntime`, the spawn provider, `MockAdapter`, and the `STRUCTURED_OUTPUT_TOOL` name.
- Data flow: starts real activations and asserts the child's behavior.
- Non-obvious design decisions: the suite drives the REAL spawn backend end to end rather than a stub, because the provider's only behaviour is what the manager does with its `prepareContinuable` result.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/src/index.ts
- Purpose: the in-process FORK backend — a child seeded with the parent's completed-turn prefix.
- Key abstractions: `ForkInProcessProvider` with `inheritsParentContext = true` and `agentPreset: false`; `completedTurnPrefix(parent)`.
- Data flow: `prepareContinuable` slices the parent's log up to and including the LAST `turn/end` and returns it as the seed; the manager creates the child with that seed.
- Non-obvious design decisions: the seed ends at the last `turn/end` because "the current tool-call turn is unbalanced and cannot be replayed as a valid child session". The prefix is captured ONCE, at creation: "it becomes part of the child's own durable transcript, so a later cold resume replays that prefix instead of re-forking the parent's newer history."
- Edge cases / failure handling: before any completed turn, the child starts fresh (an empty seed).
- Surprising: the same "do not inject `tools`" reasoning as the spawn backend, spelled out here in full.

### packages/subagent/subagent-fork-in-process/README.md
- Purpose: the English reference for the fork backend.
- Key abstractions: the standard skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the README explains WHEN to choose fork over spawn (the child must build on the parent's completed turns) and states the KV-cache consequence of the inherited prefix.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/README.zh.md
- Purpose: the Chinese translation of the fork backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/README.i18n.yaml
- Purpose: EN/ZH section hashes for the fork backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-fork-in-process`, v `0.2.1-rc.2`.
- Key abstractions: peer dependencies on `dsh-subagent`, `dsh-agent`, `dsh-session`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/locale/en.json
- Purpose: English plugin-card title ("subagent-fork-in-process").
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/locale/zh.json
- Purpose: Chinese plugin-card metadata — "继承上下文子智能体后端" / "使用父会话的一段历史创建子智能体。"
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/tsconfig.json
- Purpose: TypeScript project config for the fork backend.
- Key abstractions: references to `dsh-subagent`, `dsh-agent`, `dsh-session`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/tests/multi-subagent.spec.ts
- Purpose: the two in-process backends COEXISTING on one context — the same parent delegates to a fresh `spawn` child and a seeded `fork` child.
- Key abstractions: the real `SubagentRuntime`, both providers, `MockAdapter`.
- Data flow: the parent starts both children and keeps working itself.
- Non-obvious design decisions: the file's docblock names the point — "this is the multi-provider coexistence the seam exists for — the named registry lets one runtime hold both transports."
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts
- Purpose: the fork backend's own suite (222 lines) — the seed boundary, structured output, and the "stop with no content" finish.
- Key abstractions: the real `SubagentRuntime`, the fork provider, `MockAdapter` with a custom streaming chunk, and `STRUCTURED_OUTPUT_TOOL`.
- Data flow: starts real forked activations.
- Non-obvious design decisions: the suite includes a "bare `stop` finish that streams no content → the turn ends `completed`" case — a child that produced nothing still completes, and the selection rule must not invent output for it.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/src/index.ts
- Purpose: the out-of-process ACP backend — spawns a child ACP agent and drives it over the Agent Client Protocol.
- Key abstractions: `AcpProvider` with `NO_START_CAPABILITIES`-equivalent flags and `inheritsParentContext = false`; `Config { providerName, command, args, permission, env, disposeEofGraceMs, disposeGraceMs }`.
- Data flow: `start(request)` validates the cwd, builds an `AcpRunSpec` (including `spawn: spec => this.ctx.subprocess.spawn(spec)`), and calls `startAcpRun`.
- Non-obvious design decisions: the plugin uses NAMED EXPORTS ONLY — "a default would hide its loader metadata (see `docs/postmortem/0001-acp-default-export-drops-inject.md`)" — a postmortem reference kept in the source. The permission policy is `reject` by default: no human is ever surfaced a child's prompt. The child's `env` is layered over a CREDENTIAL-SCRUBBED parent env, so an explicit key reaches the child while ambient secrets do not leak.
- Edge cases / failure handling: the dispose graces are validated to be positive finite and no greater than `MAX_TIMER_DELAY_MS`.
- Surprising: n/a.

### packages/subagent/subagent-acp/src/run.ts
- Purpose: the fresh-process ACP client — handshake, prompt, cancellation, and quiescent disposal.
- Key abstractions: `AcpRunSpec`; `acpStopReason(reason)`; `disposeAcpChild(child, eofGraceMs)`; `startAcpRun(request, spec)`; the `AcpFailureFacts` vocabulary (stage × category).
- Data flow: spawn → `agent.initialize` → `agent.session.new` → publish → `agent.session.prompt` → `settleRunResult` → `subprocessRunHandle`.
- Non-obvious design decisions: the lifecycle id is minted in the PARENT namespace because "ACP session ids are unique only within the child server". The diagnostic is a FIXED line built only from provider-owned structured facts — "Stderr, exception text, task content, tool input, paths, environment values, credentials, and protocol payloads never enter the diagnostic". `max_turn_requests` maps to `'error'`, "so the consumer maps it to an isError result rather than reporting a partial answer as success". The teardown ladder is cooperative: stdin EOF (the child's window to flush persistence and reap its own descendants) → `terminate()` (SIGTERM → grace → SIGKILL) → whole-range exit proof.
- Edge cases / failure handling: a startup failure still reaps the process before rejecting; if cleanup ALSO fails the rejection is an `AggregateError` preserving BOTH the startup and the teardown facts "without claiming quiescence". The process-exit observation is bounded by `AbortSignal.timeout(disposeGraceMs)`.
- Surprising: the client advertises NO optional client capabilities (`clientCapabilities: {}`) — "the child self-serves in its own process".

### packages/subagent/subagent-acp/README.md
- Purpose: the English reference for the ACP backend.
- Key abstractions: the standard skeleton with a configuration table and a "Safe diagnostics" section.
- Data flow: n/a.
- Non-obvious design decisions: the README documents the diagnostic policy as a contract — one fixed line, closed facts only, 4096-byte bound.
- Edge cases / failure handling: the "Known Limitations" section names the fresh-process cost, local-workspaces-only, no start capabilities, and the fact that only committed `agent_message_chunk` text is collected.
- Surprising: the recommended configuration isolates the child with an explicit absolute `DSH_HOME`, "so a nested runtime" cannot discover the launching person's profiles or credentials.

### packages/subagent/subagent-acp/README.zh.md
- Purpose: the Chinese translation of the ACP backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/README.i18n.yaml
- Purpose: EN/ZH section hashes for the ACP backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-acp`, v `0.2.1-rc.2`.
- Key abstractions: peer dependencies on `dsh-subagent`, `dsh-subprocess`, `dsh-llm`, and the ACP SDK.
- Data flow: n/a.
- Non-obvious design decisions: unlike the Codex/Claude packages, this one ships NO `cordis.patch.yml` and no icon — it is a library, not a user-facing plugin.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tsconfig.json
- Purpose: TypeScript project config for the ACP backend.
- Key abstractions: references to `dsh-subagent`, `dsh-subprocess`, `dsh-llm`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/fixtures/acp-transport.patch.yml
- Purpose: a test patch that disables the `hooks-claude-code` and `hooks-codex` rows so the ACP transport tests use the shared model configuration "without external hooks".
- Key abstractions: a two-entry Cordis patch.
- Data flow: applied over the headless profile by the transport tests.
- Non-obvious design decisions: the patch exists to remove ambient hooks, so a transport failure cannot be blamed on a hook.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/fixtures/loader/acp.patch.yml
- Purpose: the test-only ACP provider patch over the shipped headless profile.
- Key abstractions: a Cordis patch that disables `headless-startup`/`headless-runner` and inserts the mock agent, the JSONL persistence, and the `tool-subagent` row.
- Data flow: the parent agent is configured with `provider: mock, model: mock-delegate` and `cwd: process.cwd()`; the parent OMITS `cwd` so both scenarios exercise parent-session inheritance.
- Non-obvious design decisions: the comment says the parent omits `cwd` deliberately — the fixture is designed to prove INHERITANCE, not to specify a path.
- Edge cases / failure handling: `compression: none` keeps the session log uncompressed so the e2e can read it.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/fixtures/loader/driver.ts
- Purpose: the Loader-smoke driver — one delegation turn through a headless composition.
- Key abstractions: `bootProductionProfile` + `runFixtureTurn`.
- Data flow: boots the profile, runs the fixture turn, finds the delegating parent, then `waitForChildren(parent)` and `parent.whenIdle()` and flushes the session.
- Non-obvious design decisions: the driver waits for the CHILDREN first and then the parent, so the completion notice is part of the recorded transcript.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/fixtures/loader/mock-delegating-llm.ts
- Purpose: a scripted model that performs ONE delegation and then acknowledges the receipt.
- Key abstractions: a `MockDelegatingAdapter` that emits a `tool-call` block for the `subagent` tool.
- Data flow: the parent's first turn calls the tool; later turns see the tool result and answer.
- Non-obvious design decisions: the adapter distinguishes "no tool message yet" from "tool result present", so the script is exactly two responses.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/loader-composition.e2e.ts
- Purpose: keyless REAL-composition coverage for the ACP provider through the Loader.
- Key abstractions: `runLoaderSmoke` with a driver and a patch file.
- Data flow: boots the production profile, runs the fixture turn, and inspects the persisted session events.
- Non-obvious design decisions: the file states its scope — "parent-session cwd inheritance and model-visible failure detail both cross the Loader, subprocess, ACP, tool, and persisted-session paths"; the with-key tier lives elsewhere.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/mock-acp-server.ts
- Purpose: a minimal mock ACP AGENT, run as a subprocess, fully scripted by environment variables.
- Key abstractions: `MOCK_TEXT`, `MOCK_ECHO_ENV`, `MOCK_STOP`, `MOCK_HANG`, `MOCK_IGNORE_CANCEL`, `MOCK_PERMISSION`, `MOCK_PERMISSION_IGNORE_DECISION`.
- Data flow: it speaks the agent side of ACP over stdio.
- Non-obvious design decisions: `MOCK_IGNORE_CANCEL` models a NON-COOPERATIVE child — "the backend's `result` must still settle `aborted` on its own and `dispose()` must still kill the process". `MOCK_ECHO_ENV` proves what environment actually reached the child.
- Edge cases / failure handling: every failure mode is an env flag, so the test file stays declarative.
- Surprising: the mock server is a subprocess, so the tests exercise the real spawn and teardown path.

### packages/subagent/subagent-acp/tests/subagent-acp.e2e.ts
- Purpose: the with-key cross-process proof — the backend spawns the REAL dsh ACP profile and returns its real model answer.
- Key abstractions: `LocalSubprocessRuntime`, `resolveExampleLaunch`, the real ACP profile.
- Data flow: a real child process, real ACP, real model.
- Non-obvious design decisions: it SELF-SKIPS without `DEEPSEEK_API_KEY` — the keyless tier is the default.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-acp/tests/subagent-acp.spec.ts
- Purpose: the ACP backend's keyless suite (1,499 lines) — the stop-reason map, the prompt translation, the teardown ladder, the diagnostics, and the real mock-server runs.
- Key abstractions: the mock ACP server subprocess, `LocalSubprocessRuntime`, `spawnSubprocess`, and direct unit calls into `run.ts` (`acpStopReason`, `acpContentText`, `toAcpPrompt`, `disposeAcpChild`).
- Data flow: the suite starts real ACP children through the real activation service.
- Non-obvious design decisions: the suite uses `PassThrough` streams to stand in for a subprocess handle, so the protocol path is exercised without a process.
- Edge cases / failure handling: the `MAX_TIMER_DELAY_MS` bound is asserted on the configured graces.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/src/index.ts
- Purpose: the one-shot Claude Code backend over the official Agent SDK.
- Key abstractions: `ClaudeCodeProvider` with `NO_START_CAPABILITIES`; `Config { providerName, model, env, permissionMode, disposeGraceMs }`.
- Data flow: `start(request)` validates the cwd and calls `startClaudeCodeRun` with a `ClaudeCodeRunSpec`.
- Non-obvious design decisions: the file is wrapped in `jscpd:ignore` blocks, with the comment "sibling product providers intentionally expose overlapping deployment-owned fields without adding a shared config owner" — duplication is accepted deliberately rather than abstracted into a shared config type. The permission mode default is `dontAsk`.
- Edge cases / failure handling: `disposeGraceMs` is validated positive finite and ≤ `MAX_TIMER_DELAY_MS`.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/src/process.ts
- Purpose: the projection from the shared managed-process handle onto the Claude Agent SDK's custom-spawn interface.
- Key abstractions: `sdkEnvironmentOverlay(env)`, `claudeSpawnSpec(options, graceMs)`, `ManagedClaudeCodeProcess implements SpawnedProcess`.
- Data flow: the SDK calls `spawnClaudeCodeProcess` → `spec.spawn(claudeSpawnSpec(...))` → a `ManagedClaudeCodeProcess` wrapping the shared handle.
- Non-obvious design decisions: `sdkEnvironmentOverlay` emits TOMBSTONES (`overlay[name] = undefined`) for every scrubbed ambient name the SDK removed, so a name the parent scrubbed but the SDK left alone is explicitly unset in the child. `ManagedClaudeCodeProcess` installs a no-op `error` listener at construction because EventEmitter's `error` throws without one, and the SDK attaches its own listener synchronously AFTER the spawn returns.
- Edge cases / failure handling: `kill()` is idempotent and returns `false` after exit; the `exitCode`/`signalCode` getters report the direct child's facts.
- Surprising: the SDK's spawn request is REJECTED if it omits `cwd` — "SDK spawn request omitted its workspace".

### packages/subagent/subagent-claude-code/src/run.ts
- Purpose: the one-shot Claude Code lifecycle — invoke the SDK, map only strict success to completion, dispose to quiescence.
- Key abstractions: `ClaudeCodeRunSpec`; `textTask(prompt)`; `successfulResult(message)`; `consumeClaudeQuery(query, …)`; `claudeQueryOptions(spec, controller, capture, captureDiagnostic)`; `disposeClaudeCodeChild(query, child)`; `startClaudeCodeRun`.
- Data flow: `officialQuery({ prompt, options })` → the SDK spawns the real CLI through the shared handle → the message stream is consumed → `settleRunResult` → `subprocessRunHandle`.
- Non-obvious design decisions: ONLY a `subtype: 'success'` SDK result with a non-empty `result` and no `is_error` completes the run — "Strictly derive the only SDK result that can complete a shared run." The unattended callbacks DENY every tool permission, decline every MCP elicitation, and cancel every user dialog, each recording a safe diagnostic. `persistSession: false` and `disallowedTools: ['AskUserQuestion']` (plus `ExitPlanMode` in plan mode) make the child incapable of blocking on a human.
- Edge cases / failure handling: an SDK error subtype is classified (`error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries` → `limit`); a stream that ends without a result message is an `invalid-result` error. Cleanup failures are aggregated with the startup failure.
- Surprising: `collectOutput: () => []` — the Claude path returns its answer through the SUCCESS message, not through a streamed fold.

### packages/subagent/subagent-claude-code/README.md
- Purpose: the English reference for the Claude Code backend.
- Key abstractions: the standard skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the README states the KV-cache consequence of the one-shot model — the child pays for an independent full context and the tokens never enter the parent's context.
- Edge cases / failure handling: the "Known Limitations" section names the per-run spawn cost and the local-only child.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/README.zh.md
- Purpose: the Chinese translation of the Claude Code backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/README.i18n.yaml
- Purpose: EN/ZH section hashes for the Claude Code backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-claude-code`, v `0.2.1-rc.2`.
- Key abstractions: exports include `./cordis.patch.yml` and `./locale/*.json`; `files` ships `icon.svg` and the patch.
- Data flow: n/a.
- Non-obvious design decisions: the package ships its OWN patch and icon, i.e. it is a user-facing plugin, not just a library.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/cordis.patch.yml
- Purpose: the user-facing patch that mounts the Claude Code provider AND its delegation tool.
- Key abstractions: a two-row `- insert:` list.
- Data flow: the tool row binds `provider: claude-code`, `toolName: subagent_claude_code`, and `maxDepth: provider-managed`.
- Non-obvious design decisions: `maxDepth: provider-managed` — the child CLI owns its own recursion budget, so the harness sends no cap.
- Edge cases / failure handling: n/a.
- Surprising: the patch gives the Claude Code child a DIFFERENT tool name (`subagent_claude_code`) so it coexists with the plain `subagent` tool.

### packages/subagent/subagent-claude-code/icon.svg
- Purpose: the 36×36 plugin glyph.
- Key abstractions: inline SVG with two gradient defs.
- Data flow: the plugin card.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: byte-identical to the Codex and Agent-Team icons.

### packages/subagent/subagent-claude-code/locale/en.json
- Purpose: English plugin-card metadata — "Claude Code subagent" / "Delegate one task to Claude Code using its native authentication and settings."
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: the description stresses "its native authentication and settings" — the child authenticates as Claude Code, not as the harness.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/locale/zh.json
- Purpose: Chinese plugin-card metadata for the Claude Code backend.
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tsconfig.json
- Purpose: TypeScript project config for the Claude Code backend.
- Key abstractions: references to `dsh-subagent`, `dsh-subprocess`, `dsh-llm`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/fixtures/loader/claude-code.patch.yml
- Purpose: the composition-only patch mounting named Claude Code providers and tools.
- Key abstractions: a Cordis patch disabling `headless-startup`/`headless-runner` and inserting the fixture, the default provider, and named instances such as `subagent-claude-primary`.
- Data flow: the Loader composition test boots this patch.
- Non-obvious design decisions: the comment says "No model or product process starts in this test" — the patch exists to prove the COMPOSITION loads, not the product.
- Edge cases / failure handling: n/a.
- Surprising: the same patch also inserts the CODEX provider, so one Loader composition exercises both product providers at once.

### packages/subagent/subagent-claude-code/tests/fixtures/loader/driver.ts
- Purpose: the Loader-smoke driver for the Claude Code composition.
- Key abstractions: `bootProductionProfile` with a `prepare` hook that listens on `subagent/start`.
- Data flow: boots the profile, counts the `subagent/start` events, and prints the result.
- Non-obvious design decisions: the driver deliberately does NOT invoke the product — it inspects the public composition surface.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/fixtures/loader/fixture.ts
- Purpose: a three-line re-export of the Codex fixture's parent adapter.
- Key abstractions: `export { apply, inject, name } from '…/subagent-codex/tests/fixtures/loader/fixture.ts'`.
- Data flow: n/a.
- Non-obvious design decisions: the shared fixture lives in the CODEX package and Claude Code re-exports it — the dependency direction is deliberate (the Codex one is the "original").
- Edge cases / failure handling: n/a.
- Surprising: a cross-package re-export of a TEST fixture, which is a slightly unusual but very cheap way to avoid a third copy.

### packages/subagent/subagent-claude-code/tests/loader-composition.e2e.ts
- Purpose: the public Loader composition test for the product providers.
- Key abstractions: `runLoaderSmoke` with a 60 s process timeout.
- Data flow: boots the production profile with the Claude Code patch and asserts the loaded providers and tools.
- Non-obvious design decisions: the test asserts the default instance, TWO named Claude instances, their tools, AND Codex all load "without starting either product" — a composition test that would catch a plugin whose metadata drops its `inject` (the postmortem referenced by the ACP plugin).
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/messages-fixture.ts
- Purpose: a package-private Anthropic Messages HTTP fixture.
- Key abstractions: `MessagesBehavior` = `complete` | `hold` | `tool-use`; a `createServer` that records every request.
- Data flow: the fixture answers the SDK's Messages calls.
- Non-obvious design decisions: the `hold` behaviour exists to keep a turn open so cancellation can be exercised.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/real-deepseek.e2e.ts
- Purpose: a with-key e2e running the REAL Claude Code CLI against the real harness.
- Key abstractions: `execFile` + `promisify`, `LocalSubprocessRuntime`, the real SDK.
- Data flow: a real child process, real SDK, real model.
- Non-obvious design decisions: it is gated on a key and on the CLI being present on the machine.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/real-product.spec.ts
- Purpose: the real-CLI product suite (505 lines) — the real SDK `Query` against a real CLI process.
- Key abstractions: `execFile` to run the CLI, the real `Query` type, `SDKSystemMessage`.
- Data flow: the suite drives the real product through the real activation service.
- Non-obvious design decisions: the suite stubs the SDK's spawn through the shared subprocess handle, so the real CLI runs but under the harness's managed-range ownership.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-claude-code/tests/subagent-claude-code.spec.ts
- Purpose: the Claude Code backend's keyless suite (1,665 lines) — the SDK option construction, the result mapping, the unattended callbacks, and the process projection.
- Key abstractions: `PassThrough` streams as a fake SDK process, `js-yaml` for config fixtures, the real `Loader`.
- Data flow: the suite starts activations with a stubbed SDK query.
- Non-obvious design decisions: the suite asserts `sdkEnvironmentOverlay` directly (line 730) — the tombstone behaviour is worth pinning on its own.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/src/index.ts
- Purpose: the one-shot Codex backend over the official app-server protocol.
- Key abstractions: `CodexProvider` with `NO_START_CAPABILITIES`; `Config { providerName, model, env, permissionMode, disposeGraceMs }`.
- Data flow: `start(request)` validates the cwd and calls `startCodexRun`.
- Non-obvious design decisions: the default permission mode is `never` — the safe default for unattended runs.
- Edge cases / failure handling: the same positive-finite and `MAX_TIMER_DELAY_MS` validation as the Claude sibling.
- Surprising: n/a.

### packages/subagent/subagent-codex/src/run.ts
- Purpose: the one-shot Codex lifecycle — spawn the real app-server, publish after initialization and ephemeral thread creation, flatten post-publication failures, dispose to quiescence.
- Key abstractions: `CodexRunSpec`; `codexAppServerArgv()`; `textTask(prompt)`; `disposeCodexChild(wire, child)`; `startCodexRun(request, spec)`.
- Data flow: spawn → `wire.start()` → `initialize` → `startThread` → publish → `wire.runTurn` → `settleRunResult` → `subprocessRunHandle`.
- Non-obvious design decisions: the app-server binary is resolved from the OFFICIAL PACKAGE MANIFEST (`@openai/codex/package.json`'s `bin.codex`), not from `PATH` — "Fixed package-local app-server command, independent of the host `PATH`." The task must be text-only and non-empty. `stderr` is forwarded to the host's stderr with SYNCHRONOUS `writeFileSync` ("Synchronous fd forwarding preserves byte order without owning a backpressure queue") and its failure is explicitly not a child-run authority.
- Edge cases / failure handling: the startup race is `Promise.race([wire.initialize(...), processFailure])`; a startup failure still disposes the process, and a cleanup failure is aggregated with the startup failure. A turn that ended before the terminal frame is given one I/O turn to settle before the process exit ends the run.
- Surprising: three separate `await new Promise(setImmediate)` calls appear — each one is a deliberate "let stderr already queued reach the Host" turn, documented in place.

### packages/subagent/subagent-codex/src/wire.ts
- Purpose: the minimal Codex app-server 0.153.4 protocol adapter.
- Key abstractions: `CodexAppServerWire` over the shared `JsonRpcLineTransport`; `CodexWireFailureFacts`; the three permission-mode parameter maps.
- Data flow: `initialize` → `startThread` → `runTurn`; the transport owns framing and request correlation, this module owns the product methods.
- Non-obvious design decisions: the class "deliberately exposes no generic request surface. Supporting another product method must first become part of the provider contract." The answer selection is a THREE-TIER fallback: `lastFinalAnswer` → `lastPartialAnswer` → `lastUnphasedAnswer`, each preserving exact bytes. The `partial_answer` phase is annotated with its upstream source ("openai/codex codex-rs/protocol/src/models.rs, app-server 0.162+"). Every server request is answered UNATTENDED: approvals are declined, permission grants are empty, user input returns empty answers, MCP elicitations are declined — and each records a safe diagnostic. Diagnostics are ORDER-ED (`diagnosticOrder`), so the LAST observed decision wins rather than an arbitrary one.
- Edge cases / failure handling: the thread/turn association is validated on every server request ("app-server request referenced another thread/turn"); a turn id that arrives before `turn/start` is parked and reconciled in `commitTurnId`. The `ephemeral` flag is verified on the created thread.
- Surprising: `turn/started` and `item/completed` notifications that arrive BEFORE the turn id is committed are buffered in `earlyTurnNotifications` and replayed afterwards, so no frame is lost to a race.

### packages/subagent/subagent-codex/README.md
- Purpose: the English reference for the Codex backend.
- Key abstractions: the standard skeleton.
- Data flow: n/a.
- Non-obvious design decisions: the README documents the three native permission modes and their unattended semantics.
- Edge cases / failure handling: the "Known Limitations" section names the per-run process cost and the local-only child.
- Surprising: n/a.

### packages/subagent/subagent-codex/README.zh.md
- Purpose: the Chinese translation of the Codex backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/README.i18n.yaml
- Purpose: EN/ZH section hashes for the Codex backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-codex`, v `0.2.1-rc.2`.
- Key abstractions: exports include `./cordis.patch.yml`; `files` ships `icon.svg` and the patch.
- Data flow: n/a.
- Non-obvious design decisions: the official `@openai/codex` package is resolved at runtime through `createRequire(import.meta.url).resolve('@openai/codex/package.json')` rather than a path assumption.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/cordis.patch.yml
- Purpose: the user-facing patch mounting the Codex provider and its delegation tool.
- Key abstractions: a two-row `- insert:` list.
- Data flow: the tool row binds `provider: codex`, `toolName: subagent_codex`, `maxDepth: provider-managed`.
- Non-obvious design decisions: same `maxDepth: provider-managed` reasoning as the Claude sibling — the Codex CLI owns its own recursion.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/icon.svg
- Purpose: the 36×36 plugin glyph.
- Key abstractions: inline SVG with two gradient defs.
- Data flow: the plugin card.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: byte-identical to the Claude Code and Agent-Team icons.

### packages/subagent/subagent-codex/locale/en.json
- Purpose: English plugin-card metadata — "Codex subagent" / "Delegate one task to Codex using its native authentication and settings."
- Key abstractions: the `meta` object.
- Data flow: the host plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/locale/zh.json
- Purpose: Chinese plugin-card metadata for the Codex backend.
- Key abstractions: the `meta` object.
- Data flow: the localized plugin list.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tsconfig.json
- Purpose: TypeScript project config for the Codex backend.
- Key abstractions: references to `dsh-subagent`, `dsh-subprocess`, `dsh-llm`, `dsh-sdk-protocol`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/fixtures/loader/codex.patch.yml
- Purpose: the composition-only patch mounting named Codex providers and tools.
- Key abstractions: a Cordis patch disabling the headless rows and inserting the fixture, the default provider, and named instances (`codex-primary`, `codex-secondary`) with distinct models.
- Data flow: the Loader composition test boots this patch.
- Non-obvious design decisions: "No model or product process starts in this test" — the patch exists to prove the composition loads.
- Edge cases / failure handling: n/a.
- Surprising: the named instances carry DIFFERENT models, so the composition test proves the per-instance model config is honoured.

### packages/subagent/subagent-codex/tests/fixtures/loader/driver.ts
- Purpose: the Loader-smoke driver for the Codex composition.
- Key abstractions: `bootProductionProfile` with a `prepare` hook counting `subagent/start` events.
- Data flow: boots the profile and reports the loaded composition.
- Non-obvious design decisions: the driver never invokes Codex.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/fixtures/loader/fixture.ts
- Purpose: a parent adapter that FAILS if the composition test starts a turn.
- Key abstractions: `CompositionOnlyAdapter extends LlmAdapter` whose `stream` throws.
- Data flow: the fixture registers the adapter under the `mock` provider id.
- Non-obvious design decisions: the adapter's only job is to make an accidental model call LOUD — "subagent-codex Loader composition must not invoke a model".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/loader-composition.e2e.ts
- Purpose: the Codex provider's public Loader composition test.
- Key abstractions: `runLoaderSmoke` with a 60 s process timeout.
- Data flow: boots the production profile with the Codex patch.
- Non-obvious design decisions: the test asserts the default instance, TWO named instances with their models, their tools, AND the job controls all load "without starting Codex".
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/deepseek-responses-bridge.ts
- Purpose: a test-only bridge that converts the Responses protocol into DeepSeek's own API shape.
- Key abstractions: an `http.createServer` with a 1 MiB request cap.
- Data flow: the Codex app-server talks Responses to the bridge; the bridge talks DeepSeek.
- Non-obvious design decisions: the bridge exists so a REAL Codex app-server can be driven against a REAL DeepSeek answer without a real DeepSeek key.
- Edge cases / failure handling: the request body is bounded at 1 MiB.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/real-deepseek.e2e.ts
- Purpose: a with-key e2e running the real Codex app-server against the real model.
- Key abstractions: `execFile` + `promisify`, `createRequire` to resolve the Codex package, `LocalSubprocessRuntime`.
- Data flow: a real app-server process, a real turn, a real answer.
- Non-obvious design decisions: the suite is gated on a key.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/real-product-cleanup.ts
- Purpose: a cleanup helper that disposes Codex test contexts, HTTP fixtures, and temp roots, attributing failures.
- Key abstractions: `cleanupRealProduct(resources)` with three registries.
- Data flow: called from the real-product suites' `afterEach`.
- Non-obvious design decisions: it CAPTURES all registries BEFORE awaiting ("Captures all registries before awaiting, so later tests retain their resources") and attempts every captured cleanup before reporting failures.
- Edge cases / failure handling: each failure stage keeps its original cause.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/real-product-cleanup.spec.ts
- Purpose: the cleanup helper's own contract.
- Key abstractions: `cleanupRealProduct` called with deliberately failing disposers.
- Data flow: n/a.
- Non-obvious design decisions: the suite asserts the message names the STAGE ("Codex test context disposal failed") AND the original cause is preserved.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/real-product.spec.ts
- Purpose: the real-Codex product suite (505 lines) against the real app-server.
- Key abstractions: `execFile`, the real Codex package resolved through `createRequire`, `LocalSubprocessRuntime`.
- Data flow: a real app-server, a real thread, a real turn.
- Non-obvious design decisions: the suite COPIES the Codex package into a temp directory (`cpSync`) so the app-server's own resolution is isolated from the developer's machine.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/responses-fixture.ts
- Purpose: a package-private Responses HTTP fixture.
- Key abstractions: `ResponsesBehavior` = `complete` | `error`; a `createServer` recording every request.
- Data flow: the fixture answers the app-server's Responses calls.
- Non-obvious design decisions: the recorded request shape is exposed so a test can assert what the app-server actually sent.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-codex/tests/subagent-codex.spec.ts
- Purpose: the Codex backend's keyless suite (2,228 lines) — the wire protocol, the permission answering, the stop reasons, and the diagnostics.
- Key abstractions: `PassThrough` streams as a fake app-server, `js-yaml` for config fixtures, the real `Loader`, the real `SubagentRuntime`.
- Data flow: the suite drives the wire through the real activation service.
- Non-obvious design decisions: the suite exercises the wire's ORDERING behaviour (early notifications buffered until the turn id is committed) and its UNATTENDED answers (a declined command approval still produces a diagnostic).
- Edge cases / failure handling: `MAX_TIMER_DELAY_MS` is asserted on the configured grace.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/src/index.ts
- Purpose: the out-of-process DSH-SDK backend — a complete Harness runtime in its own process.
- Key abstractions: `SdkSubagentProvider` with `SDK_START_CAPABILITIES` (`agentOptions: true`, everything else false) and a frozen `agentRouteDefaults`.
- Data flow: `start(request)` resolves the route (provider/model/effort/maxTokens), builds an `SdkRunSpec`, and calls `startSdkRun`.
- Non-obvious design decisions: the provider publishes its `agentRouteDefaults` so the tool can show a truthful baseline BEFORE the model's overrides, and the route is a WHITELIST: only `provider`, `model`, `reasoningEffort`, and `maxTokens` cross the SDK wire. The child keeps its parent's ORIGIN directory (`originCwd`) while STARTING in the selected directory (`cwd`) — the two are deliberately different.
- Edge cases / failure handling: `dshHome` must be absolute; the patch files and `dshBin` are resolved and checked to be EXISTING FILES at PLUGIN LOAD, not at first use.
- Surprising: the plugin uses named exports only, for the same postmortem reason as the ACP plugin.

### packages/subagent/subagent-dsh-sdk/src/run.ts
- Purpose: the fresh-process SDK client — handshake, prompt, answer extraction, and quiescent disposal.
- Key abstractions: `SdkRunSpec`; `internals.createHarness` (a seam replaced only by package-local fake-runtime tests); `sdkChildOutcome(reason)`; `startSdkRun(request, spec)`.
- Data flow: `internals.createHarness({...})` → `harness.start()` (the handshake) → publish → `harness.client.prompt(...)` → `harness.client.request('session/wait', …)` → `settleRunResult` → `subprocessRunHandle`.
- Non-obvious design decisions: the answer is extracted from the ORDERED session events through the shared `AssistantOutputFold` — "the last complete non-empty `assistant/message` (an empty-content message that records usage is skipped), or the accumulated `text-delta` stream when no such message exists". The subscription is drained in a `finally` so "Cancellation and transport failure retain every event already received". The child environment is the shared scrub PLUS the explicit `env`, applied by THIS backend because the SDK client spawns the child rather than `ctx.subprocess` — "the documented exception for SDK-managed transports".
- Edge cases / failure handling: `sdkChildOutcome` maps the child's durable `turn/end` reason — `blocked` → `refusal`, `interrupted` → `error`, a missing terminal → `error` with a `missing-terminal` diagnostic, and an unnameable reason → `error` with `child-unknown`. Disposal is a bounded protocol `shutdown` then the SDK's own ladder.
- Surprising: the child session id (`session-<uuid>`) is minted INSIDE the child process while the lifecycle id is minted in the parent — two namespaces, deliberately.

### packages/subagent/subagent-dsh-sdk/README.md
- Purpose: the English reference for the DSH-SDK backend.
- Key abstractions: the standard skeleton with a configuration table.
- Data flow: n/a.
- Non-obvious design decisions: the README explains the route whitelist and the `maxDepth: 'provider-managed'` recommendation, and documents the origin-vs-effective directory split.
- Edge cases / failure handling: the "Failure and recovery" section names every failure code the provider can produce.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/README.zh.md
- Purpose: the Chinese translation of the DSH-SDK backend reference.
- Key abstractions: same section structure.
- Data flow: linked from the English file.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/README.i18n.yaml
- Purpose: EN/ZH section hashes for the DSH-SDK backend README.
- Key abstractions: the per-heading hash map.
- Data flow: the translation-pairing gate.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/package.json
- Purpose: the manifest for `@deepseek-ai/dsh-subagent-dsh-sdk`, v `0.2.1-rc.2`.
- Key abstractions: peer dependencies on `dsh-subagent`, `dsh-sdk-client`, `dsh-llm`, `dsh-subprocess`.
- Data flow: n/a.
- Non-obvious design decisions: the package does NOT ship a patch or an icon — it is a library backend, unlike the Codex/Claude products.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tsconfig.json
- Purpose: TypeScript project config for the DSH-SDK backend.
- Key abstractions: references to `dsh-subagent`, `dsh-sdk-client`, `dsh-llm`, `dsh-subprocess`.
- Data flow: n/a.
- Non-obvious design decisions: n/a.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/child-mock-llm.ts
- Purpose: the scripted model for the CHILD runtime.
- Key abstractions: a `RouteEchoAdapter` that resolves a model with a `max` reasoning effort.
- Data flow: the child runtime calls it and it echoes the effective route.
- Non-obvious design decisions: the failure mode streams partial text BEFORE a fixed provider error, "so the parent can assert safe diagnostics" are separate from partial output.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/child.patch.yml
- Purpose: the child runtime's SDK profile patch.
- Key abstractions: a Cordis patch disabling the key-based `llm-deepseek` and configuring a `system-prompt` persona and the skill filesystem.
- Data flow: applied inside the child runtime.
- Non-obvious design decisions: `personaPrefix: 'Echo where you run.'` — the child's own prompt proves it is running in the selected directory.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/driver.ts
- Purpose: the Loader-smoke driver — one delegation turn through a headless composition.
- Key abstractions: `bootProductionProfile` + `runFixtureTurn`.
- Data flow: boots the profile, runs the turn, waits for the children, then the parent, and flushes.
- Non-obvious design decisions: identical in shape to the ACP driver, so both providers' Loader paths are exercised the same way.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/dsh-sdk.patch.yml
- Purpose: the test-only SDK provider patch over the shipped headless profile.
- Key abstractions: a Cordis patch disabling the headless rows and configuring the mock agent and JSONL persistence.
- Data flow: the parent omits `cwd` to exercise inheritance, exactly as the ACP patch does.
- Non-obvious design decisions: `compression: none` keeps the transcript readable for the assertions.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/mock-delegating-llm.ts
- Purpose: the parent-side scripted model that performs one delegation.
- Key abstractions: a `MockDelegatingAdapter` that appends the effective route to a record file when `DSH_TEST_PARENT_MODEL_RECORD` is set.
- Data flow: the parent's first turn calls the `subagent` tool.
- Non-obvious design decisions: the record file is how the test proves the parent resolved the route it selected.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/nested-mock-llm.ts
- Purpose: a GATED nested fork for the SDK and ACP task-completion profile tests.
- Key abstractions: a `NestedAdapter` that writes a READY file and then polls for a RELEASE file.
- Data flow: the nested child signals readiness and then blocks until the test releases it.
- Non-obvious design decisions: the file-based gate is how the test holds a nested delegation open across a PROCESS boundary — a promise cannot cross processes.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/fixtures/loader/scoped-tool-subagent.ts
- Purpose: a plugin that mounts the delegation tool in EACH fixture Agent's scope.
- Key abstractions: `apply(ctx, config)` installing via `agent.ctx.inject(ToolSubagent.inject, …)`.
- Data flow: the fixture installs the tool before a published Agent starts its loop.
- Non-obvious design decisions: the tool is installed per Agent scope rather than globally, so the fixture can point different Agents at different providers.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/loader-composition.e2e.ts
- Purpose: keyless REAL-composition coverage for dynamic child routing and parent cwd inheritance across the SDK wire.
- Key abstractions: `runLoaderSmoke`; a COMPLETE second harness runtime that echoes the effective route and cwd.
- Data flow: a scripted model selects provider/model/reasoning, the tool config adds `maxTokens`, and the child runtime echoes what it received.
- Non-obvious design decisions: the same path verifies that "model-visible child-failure diagnostics remain separate from partial output" — the two are asserted independently.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/nested-delegation.e2e.ts
- Purpose: proves a full child profile must finish its NESTED fork before its external task settles.
- Key abstractions: `createProcessDeepSeekHarness`, `spawnSubprocess`, and BOTH `startAcpRun` and `startSdkRun` in one suite.
- Data flow: the outer external task spawns a child that itself forks, and the outer's result must wait.
- Non-obvious design decisions: the suite drives two different out-of-process backends through the SAME nesting contract — the seam's behaviour, not a product's, is what is being pinned.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

### packages/subagent/subagent-dsh-sdk/tests/subagent-dsh-sdk.spec.ts
- Purpose: the DSH-SDK backend's keyless integration suite (930 lines) — each case spawns a REAL subprocess (the SDK client's scripted fake runtime) and drives it over REAL stdio JSON-RPC.
- Key abstractions: `internals.createHarness` is replaced by a scripted fake runtime; real JSON-RPC over real pipes.
- Data flow: the handshake, the turn round-trip, the stop-reason mapping, cancellation, env scrubbing, and quiescent disposal are all exercised end to end.
- Non-obvious design decisions: the suite states "No model, no key" and still uses REAL processes and REAL pipes — the fidelity is in the transport, not the model.
- Edge cases / failure handling: n/a.
- Surprising: n/a.

## Ideas worth stealing

- **Derive the child's stop reason from the child's own log, never from the fact that teardown succeeded** — `packages/subagent/subagent/src/lifecycle.ts:134` — `epochStopReason(events)` folds the child's `turn/end` event via `foldConsumedWork` and maps `blocked` → `refusal`, `aborted`/`interrupted` → `aborted`, and an UNNAMEABLE future variant → `error`. The comment is the whole lesson: "teardown succeeding says nothing about whether the model errored, hit its token ceiling, or was cancelled, so deriving the reason from disposal would report failed work as completed." August's own harness already has a `turn_end {reason}` vocabulary — this is the same discipline applied to a subagent, and it is exactly the fix August needed when a teardown error was reported as a completed answer.

- **Make the result promise NEVER reject after publication; flatten every failure to a stop reason** — `packages/subagent/subagent/src/out-of-process.ts:151` — `settleRunResult` takes the attempt, the output snapshot, a cancellation predicate, and a contained diagnostic sink, and returns a `SubagentResult` with `stopReason: 'error'` instead of throwing. The abort listener is removed in a `finally`, so a late abort cannot double-fire. August's `turn_end {reason, rounds, error}` ledger and its `isError` tool-result mapping both want exactly this shape: a provider failure becomes a FACT in the result, not an exception that unwinds the caller.

- **Snapshot the parent's policy and options BEFORE the first `await`** — `packages/subagent/subagent/src/manager.ts:404` — `captureDelegatedPolicyOverrides(parent)` is called synchronously, with the comment "Capture before the first await: a later parent switch belongs to the parent's future, not to this child." The child's approval policy is then pinned to `'never'` REGARDLESS of the parent's own policy, and the whole policy is written onto the child's own log as `source: 'delegation'` events so it is reconstructable from the log alone. August has the same hazard (a parent switching permission mid-turn); this is the pattern — capture the decision at the delegation boundary, write it to the child's durable log, and pin the child's ask path to deterministic rejection.

- **Derive the effective child route from the parent's LATEST LOGGED REQUEST, not its creation options — and clear the route-owned effort when the route changes** — `packages/subagent/subagent/src/child-agent.ts:68` and `:116` — `parentAgentOptionsForDelegation` reads `parent.session.requestHeader()?.config` and only falls back to `parent.options` before the first request; `resolveChildAgentOptions` deletes the inherited `reasoningEffort` when provider or model changes, "so the selected model resolves its own default". August's model-selection and effort-plumbing work would benefit from the same rule: a route change without a named effort must not carry a stale effort from the old route.

- **A two-phase commit for a tool-produced result, keyed by the EXECUTION object rather than the call id** — `packages/subagent/subagent/src/structured.ts:70` — the capture is STAGED in a `Map<ToolExecution, {value}>` at execute time and COMMITTED only when the authoritative `tools/result` notification arrives, because "a later transformable waterfall may still turn the success into an error". The docblock names the trap: "adapter call ids may repeat across steps, but another execution can never reach this Map entry." A terminal guard is then installed so a later PREPENDED listener cannot resurrect dispatch. August's structured-output / verdict path has exactly the same hazard (a result that a post-execute policy can still turn into an error).

- **One shared "delegate" tool whose DESCRIPTION changes with the provider's context-inheritance contract** — `packages/subagent/tool-subagent/src/index.ts:113` — `providerWording(inheritsConversation)` produces "it does not see this conversation" for a fresh child and "it does not see the current in-flight turn" for a forked one, with the stated reason: "telling the model to restate everything (or, worse, that the child 'does not see this conversation') would be false for a fork." The same file also mounts the tool only while its provider exists and re-derives the depth notice at every request. This is a directly transferable pattern for August: make the tool's own schema text a function of the capability the backend actually has.

- **A "no-progress" fast path for a wait tool, so the model never polls** — `packages/experimental/tool-agent-team/src/index.ts:264` — `wait_agent` reads the roster synchronously and, if no other member is `running` or `provisioning`, returns `{ timedOut: false, noProgress: { reason: 'no-active-peer', message: … } }` immediately rather than sleeping. The comment is explicit that "the active-peer read and waiter registration must remain one synchronous span; awaiting between them can lose the only peer-status edge." The companion `list_agents` description says "there is no need to keep checking its status." August's bot/turn loops have the same polling pathology; this is the shape of the fix.

- **A compare-and-set revision fence on every shared-state mutation** — `packages/experimental/agent-team/src/task-board.ts:115` — `update` refuses with `TEAM_TASK_STALE_REVISION` when `current.revision !== request.expectedRevision`, and the whole value (not a patch) is written with `revision + 1`. The projection then re-validates the whole dependency graph on every event, so a log written by any path cannot contain a cycle. August's task/journey state would get the same safety from the same pair: a CAS fence plus a fold-time invariant check.

- **A capacity POOL shared by a root and its descendants, reserved BEFORE the asynchronous child creation and released only after the handle's disposal** — `packages/subagent/subagent/src/activation.ts:24` and `packages/subagent/subagent/src/manager.ts:744` — `ActivationPool.reserve` is a `Set<symbol>` of slots, and the manager reserves before `materialize` and releases in the disposal's `finally`. The pool is keyed on the ROOT (`rootPools` is a `WeakMap<Agent, ActivationPool>`), so a tree shares its budget and separate roots are isolated. At capacity the error message tells the model what to do: "wait for an existing child to finish or complete this work with the current agents."

- **A durable descriptor that snapshots EXPLICIT fields instead of a merge-extensible options object** — `packages/subagent/subagent/src/descriptor.ts:48` — `SUBAGENT_DESCRIPTOR_VERSION = 3`; the parser is a strict closed-schema validator and an unknown field THROWS, while a different version folds to `undefined` ("the child cannot be classified by this runtime"). The docblock gives the rule: "an unrelated extension value cannot make continuation fail merely because it is not JSON, and later composition inputs require a deliberate version change." August's skill/prompt descriptors would benefit from the same explicit-field discipline.

- **A monotone depth floor taken from the PERSISTED header, so a resumed child can never delegate as if it were top-level** — `packages/subagent/subagent/src/depth.ts:28` — `delegationDepthOf` returns `Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)`; the runtime value may DEEPEN but never LOWER the count. The runtime value is validated as a non-negative safe integer, with `-0` explicitly rejected. This is the recursion-budget rule August's agent-tree work needs, stated once and enforced in one place.

- **A model-facing scope statement injected as a RUNTIME-CONTEXT contribution, not a system-prompt section** — `packages/subagent/subagent/src/child-agent.ts:171` — `SUBAGENT_DELEGATION_CONTEXT` says the child's "permission scope was fixed when you was started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it." The reason for a context contribution rather than a prompt section: "the deployment's system prompt stays uniform across parents and children" — which also keeps the cached prefix stable.

- **A one-line, fixed-shape, byte-bounded diagnostic built ONLY from closed provider facts** — `packages/subagent/subagent/src/out-of-process.ts:30` — `limitSubagentDiagnostic` truncates to 4,096 UTF-8 bytes by walking back over continuation bytes so a multi-byte sequence is never split, and appends a visible `[diagnostic truncated]`. Every provider's diagnostic is assembled from a closed vocabulary (provider, stage, category, exit code, signal) and never from exception text, stderr, paths, or payloads. August's `turn_end` diagnostics and its error receipts want the same closed-fact discipline.

- **A `null` sentinel where a projection value must survive `JSON.stringify`** — `packages/subagent/subagent/src/projection.ts:127` and `packages/subagent/subagent/src/projection-types.ts:69` — the identity projection's no-value state is the serializable `null` arm, "never `undefined` — so every registry read and push frame survives JSON.stringify losslessly, where an `undefined` field would be dropped and a stale identity would survive on the receiving side." A projection fold must also never throw: a malformed payload folds to no value.

- **Freeze the child's environment with TOMBSTONES, not just an overlay** — `packages/subagent/subagent-claude-code/src/process.ts:30` — `sdkEnvironmentOverlay` copies the SDK's environment and then sets `overlay[name] = undefined` for every ambient name the shared scrub removed but the SDK left alone, so the child provably does not inherit it. August's credential-scrub work (the outbound-body scrub and the store collectors) has the same requirement, and the tombstone is the part that is easy to forget.

- **Resolve the product binary from the official package manifest, not from `PATH`** — `packages/subagent/subagent-codex/src/run.ts:44` — `createRequire(import.meta.url).resolve('@openai/codex/package.json')` then `resolve(dirname(...), manifest.bin.codex)`, and the argv is `[process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']` — "Fixed package-local app-server command, independent of the host `PATH`." A hosted product command that resolves the same way on every machine is a small, high-value reliability win.

- **Buffer protocol notifications that arrive before the request that names them, then replay them** — `packages/subagent/subagent-codex/src/wire.ts:449` — `earlyTurnNotifications` holds `item/completed` / `turn/completed` frames that arrived before the turn id was committed, and `commitTurnId` replays them in order. The wire also validates the thread/turn association on EVERY server request ("app-server request referenced another turn"). This is the standard fix for "the server started talking before I asked it to".

- **A `waitForChildren` join that RE-CHECKS after every wake, because a descendant can be published while another child's idle wait is still resolving** — `packages/subagent/subagent/src/manager.ts:252` — the loop rebuilds its wait set on every iteration and only returns when the wait set is empty AND no new materialization or resident child appeared. It also leaves idle parked inboxes resident rather than blocking host completion. August's "wait for the whole tree" semantics need the same re-check loop.

## Files skipped (with reasons)

- None. Every one of the 249 files in this shard was opened and read. Depth varies: all `src/` modules, all READMEs, and all `package.json`/`tsconfig.json`/`locale/*.json`/`cordis.patch.yml`/`icon.svg` files were read in full. The large spec files were read in their headers plus their complete `describe`/`it` inventory and, where the mechanism mattered, their bodies — `packages/subagent/subagent/tests/continuation.spec.ts` (4,044 lines) was read in full at the head plus the capacity and settlement-delivery blocks; `packages/subagent/subagent/tests/structured.spec.ts` (1,003), `packages/subagent/subagent/tests/service.spec.ts` (656), and the provider suites (`subagent-codex.spec.ts` 2,228, `subagent-claude-code.spec.ts` 1,665, `subagent-acp.spec.ts` 1,499, `packages/experimental/agent-team/tests/team.spec.ts` 1,361) were read at their headers and test inventories. Their assertions are named in the notes above, and where a note asserts a specific behaviour I read the corresponding test body.

## Uncertainties

- I did not verify the CLAIM that `packages/subperimental/agent-team-profile/cordis.patch.yml` disables a real `tool-subagent-fork` id. I checked the manifest for this shard and found `tool-subagent-fork` nowhere in the 249 rows; I did not grep the rest of the clone, so it may live in a package owned by another shard, or it may be a stale id.
- The `docs/subsystems/subagent.md` page and the archived design notes referenced by the READMEs are outside this shard and were not read; where I describe a contract I read it from the code and the package README in this shard.
- `packages/subagent/subagent/src/structured.ts` is ONE file in the manifest; the rows TSV records it once and this report carries one `###` heading for it.
- I did not read the implementations of the packages this shard depends on (`dsh-agent`, `dsh-agent-loop`, `dsh-session`, `dsh-session-projection`, `dsh-subprocess`, `dsh-tools`, `dsh-system-prompt`, `dsh-scope`, `dsh-typert-protocol`). Every statement about their behaviour in this report is inferred from the CALL SITES inside the shard, and is flagged in the notes as the shard's own docblock text rather than as an independent verification.
- The four `README.zh.md` files in the `subagent-*` provider packages and the two in `experimental/*` were opened and confirmed to be section-for-section Chinese counterparts of their English siblings, but I did not diff their prose against the English line by line — the `README.i18n.yaml` hash files are the mechanism that enforces that, and I did not recompute those hashes.
- I could not determine whether `packages/subagent/subagent/src/manager.ts` and `packages/subagent/subagent/src/activation.ts` are the only two places a child Activation's capacity slot is reserved; I checked every `reserve(` call site inside the shard and found only those, but a reservation could exist in a package outside the shard.
