# deepseek-harness / dsh-skill-goal

Shard: `dsh-skill-goal` · Repo: `deepseek-harness` @ `687f282e` · 171 files · 1,150,300 bytes

## Shard shape

This shard is four adjacent "capability family" package groups that all live in the agent's
*control plane* rather than in the model loop itself: **`packages/goal/`** (a durable
per-session completion objective with model tools, a human slash command, and an automatic
continuation driver), **`packages/skill/`** (a provider registry that merges skill catalogs from
any source, a local-filesystem provider with a directory watcher, a bundled Office provider, the
model-facing `skill` loader + durable session catalog, and a tool that reports bundled interpreter
paths), **`packages/spill/`** (a one-method storage seam, a local-filesystem backend, and a
token-budgeted tool-result retention policy that keeps oversized output out of the context), and
**`packages/todo/`** (a single model-facing `todo_write` tool whose list is a whole-value
replacement in the session log). The architecture is consistent across all four: a **Cordis
service owns the state**, a **session-log event is the durable truth**, a **session projection
serves the client**, and **tool-facing packages enforce authority at execution time** rather than
trusting the model. The two families that touch the model's input (`skill`, `spill`) are the two
that carry explicit **"Model Experience"** sections in their READMEs documenting token cost and
**KV-cache effect** — this repo treats prompt-prefix stability as a first-class design constraint,
which is the single most transferable idea in the shard.

---

## Per-file notes

### packages/goal/ — the durable goal family

#### packages/goal/README.md
- Purpose: Group map for the four goal packages.
- Key abstractions: `goal` (state), `tool-goal` (model tools), `command-goal` (human command), `goal-round-driver` (scheduler).
- Data flow: goal → tools/command → driver; the service stores, it never schedules.
- Non-obvious design decisions: The group README states explicitly that "that goal records completion state rather than scheduling work; automatic continuation must therefore be enabled separately" — the *state* and the *schedule* are deliberately different packages.
- Edge cases / failure handling: n/a (map page).
- Surprising: A goal is one-per-session; the driver is optional.

#### packages/goal/README.zh.md
Chinese translation of `packages/goal/README.md` (52 lines, same anchors); section headings are localized ("概述", "目录", "开发备注").

#### packages/goal/README.i18n.yaml
Per-heading EN/ZH content hashes for the group map, re-recordable with `pnpm run verify-translation-pairing --write packages/goal/README.md`.

#### packages/goal/goal/src/types.ts
- Purpose: The pure, client-safe half of the goal domain and the **single** home of the `goal` session-projection key declaration.
- Key abstractions: `GoalId` (branded), `GoalRef {id, revision}` (compare-and-set identity), `GoalSnapshot`, `GoalPhase`, `GoalActivation`, `GoalView`, `GoalProjection`, `GoalProjectionState`.
- Data flow: Declares `SessionProjectionStateMap['goal']` and `SessionProjectionMap['goal']` via module augmentation, plus the `goal/activation-changed` cordis event.
- Non-obvious design decisions: `GoalActivation` (`armed`/`disarmed`) is **process-local and never persisted** — the projection deliberately omits it so a replay can never resurrect automatic authority.
- Edge cases / failure handling: `GoalBlockReason.code` is documented as a "stable lower-kebab-case classification chosen by the blocking policy" — a machine-routable code plus a human message, one durable phase instead of many lifecycle states.
- Surprising: Two namespace projections (`./types` for host, `./client` for browser) serve the same content with zero duplication.

#### packages/goal/goal/src/domain.ts
- Purpose: Host-side vocabulary that may import dsh-agent/dsh-llm/cordis.
- Key abstractions: `GoalChangeMeta` = snapshot change ∪ clear tombstone; `GoalMessageSource {goalId, revision, round}`; the scoped `goal/changed` event.
- Data flow: A `goal/change` session event carries the **complete post-mutation snapshot**; `user/message` events with a `goal` source carry admitted continuation rounds.
- Non-obvious design decisions: The `goal/changed` cordis event is emitted **after** the durable event commits and its payload is scope-filtered (`Scoped<Agent>`), so a listener sees only its own agent.
- Edge cases / failure handling: "Listener failures are contained."
- Surprising: The projection state is deliberately separated from the projection value: the host state keeps `seenGoalIds` + `failure`, the client sees only the current goal.

#### packages/goal/goal/src/runtime.ts
`GoalId()` brand helper, the `GoalError` class (a `HarnessError` subclass whose constructor is narrowed to the `GoalErrorCode` union), and the `GOAL_CHANGE_VERSION = 1` constant — 30 lines total.

#### packages/goal/goal/src/client.ts
Ten-line pure `export type * from './types.ts'` — the browser half-entry projecting the same single-source content the host outlet serves.

#### packages/goal/goal/src/fold.ts
- Purpose: The strict replay fold and decoder for durable goal facts — the integrity layer.
- Key abstractions: `GoalFoldState` (mutable accumulator), `decodeGoalChange`, `applyGoalChange`, `applyGoalEvent`, `foldGoal`.
- Data flow: session events → `decodeGoalChange` (exact-field validation) → transition rules → folded projection. `user/message` with a `goal` source advances `roundsStarted` and only if it is exactly `roundsStarted + 1` of the *current* revision.
- Non-obvious design decisions: Decoders require **exact** key sets (`Object.keys(value).sort().join(',') !== expectedKeys`) rather than ignoring unknown fields; a `blocked` snapshot must have `blockedReason` and a non-blocked one must not. Every non-create mutation must advance the revision by exactly one and preserve `roundsStarted`/`createdAt`. `create` requires revision 1, phase `active`, zero rounds, and a **never-before-seen goal id** (`seenGoalIds`).
- Edge cases / failure handling: `updatedAt < createdAt` throws; a clear tombstone must be revision+1 over the current and must not precede the last update; `goalSource` rejects a non-positive round. `resume` is rejected when `roundsStarted >= maxGoalRounds`.
- Surprising: The fold is *pure and total* — it never touches the filesystem or a service, so it can be replayed against a forked or seeded log byte-for-byte.

#### packages/goal/goal/src/index.ts
- Purpose: `GoalService` (`ctx.goals`) — the owner of goal state.
- Key abstractions: `GoalService extends TypertRemoteService` with `@Remote('get'|'create'|'edit'|'pause'|'resume'|'complete'|'clear')`; `goalProjectionDefinition` (stateVersion 6); `applyGoalProjection`; the per-session `runtimeStates` WeakMap.
- Data flow: `create/edit/pause/...` → validate → build the next snapshot → `session.append('goal/change', change)` → the projection registry folds it → `goal/changed` is emitted → the view is rebuilt.
- Non-obvious design decisions: (a) **Activation is not an event** — it lives in a `WeakMap<Session, GoalRuntimeState>` and is *disarmed on every `agent/created` edge*, so a resumed or forked session never continues on its own. (b) The commit path sets `runtime.pendingActivation` **before** the append and reads it back keyed on `SessionSeq(offset) === event.seq`, so activation and the durable event cannot desynchronise. (c) `expectCurrent` enforces exact `{id, revision}` compare-and-set and throws `GOAL_STALE_REVISION` with both revisions named. (d) `assertLive` compares **object identity** (`ctx.agents.get(agent.id) !== agent`), not id equality. (e) `nextMutationTime` clamps with `Math.max(Date.now(), state.updatedAt)` so a backward wall clock cannot produce a non-monotonic timestamp.
- Edge cases / failure handling: `applyGoalProjection` catches the strict fold's throw and stores it in `state.failure` — the client view keeps the **last valid goal** while `GoalService.state()` throws that failure, so one corrupt record bricks host access without crashing the projection drive.
- Surprising: `disarm()` removes continuation authority **without writing a revision or emitting a mutation** — a lifecycle owner can stop the machine without touching durable state.

#### packages/goal/goal/tests/projection.spec.ts
- Purpose: The projection unit's contract.
- Key abstractions: `Bench` harness with `tailValues()`/`tailAsOfSeq()`; a `liveAgent` stub.
- Data flow: Mount `GoalService` beside the registry → the projection serves the current goal on the history-tail page with `asOfSeq = session.seq - 1`.
- Non-obvious design decisions: The projection's client view is the **whole** goal (`toMatchObject`), not a cropped one, and the value is `null` before the first create and after a clear tombstone.
- Edge cases / failure handling: Pinned here: a malformed `goal/change` sets `failure` instead of throwing; an inbox splice does not revive a cleared goal; the `goal` key is absent when the service is not composed and is removed when the fiber unloads (HMR safety); a projected state with `seenGoalIds: []` fails the zod schema.
- Surprising: `applyGoalProjection` returns the **same state reference** for an unrelated event — the registry drives *every* committed event through it, so the early return is load-bearing.

#### packages/goal/goal/tests/goal.spec.ts
- Purpose: The domain's main spec (840 lines, 39 cases).
- Key abstractions: `stubAgentForSession` builds a registry-compatible agent over a real `Session`; `appendRound` appends a balanced `turn/start` → `user/message` → `turn/end` triple.
- Data flow: Service methods → session events → `decodeGoalChange`/`foldGoal` assertions.
- Non-obvious design decisions: The spec asserts the **`resources` field is absent** on the `goals/get` remote marker ("leaving its Session resource to the Agent lookup") — the remote boundary does not re-declare a resource the agent lookup already owns.
- Edge cases / failure handling: Pinned: a same-id agent backed by a different session object is rejected as `GOAL_AGENT_NOT_LIVE`; a throwing `goal/changed` listener is contained and later listeners still fire; a reentrant `session/event` observer sees the *same* value as `ctx.goals.get`; an externally appended `goal/change` disarms local activation; the wall clock moving backward keeps per-goal timestamps monotonic; fork inherits the completed-turn goal prefix with the child disarmed.
- Surprising: `disarm()` writes **zero** session events — asserted by comparing `snapshotEvents().length` before and after.

#### packages/goal/goal/tests/goal.e2e.ts
Runs the **production headless profile** through the Loader smoke harness, then parses the on-disk `.sessions/*.jsonl` to assert exactly one `goal/change` with `maxGoalRounds: 7`, no `activation` key in the persisted JSON, and **no** goal-sourced round > 0 — i.e. the goal change is independent of model-visible messages.

#### packages/goal/goal/tests/fixtures/domain/seed-goal.ts
Test-only Loader plugin that creates a goal at the first `agent/pre-step` and then calls `ctx.goals.disarm(agent)` — the comment explains that an armed goal would make the shipped driver start a round at idle and race the test driver's disposal.

#### packages/goal/goal/tests/fixtures/domain/goal.patch.yml
Test-only patch over the shipped headless profile: disables `headless-startup`/`headless-runner`, sets `defaultMaxGoalRounds: 11`, swaps in a `cli-mock` agent and the `seed-goal` plugin, and points JSONL persistence at `./.sessions` with `compression: none`.

#### packages/goal/goal/package.json
Publishes `@deepseek-ai/dsh-goal` 0.2.1-rc.2 with four export subpaths (`.`, `./types`, `./client`, `./typert`, `./remote`) — the typert ones exist so the host and the remote client can be bundled separately.

#### packages/goal/goal/tsconfig.json
Extends `tsconfig.base.json`; references cosmokit/schemastery/cordis/brand/llm/core-session/core-scope/core-agent/session-projection/typert.

#### packages/goal/goal/tsdown.config.ts
One tsdown entry: ESM, node platform, es2024 target, `dts: false`, `clean: false`, built from `lib/types/index.js` into `lib`.

#### packages/goal/goal/locale/en.json · packages/goal/goal/locale/zh.json
Locale catalogues: `en.json` holds only `meta.title` ("goal"); `zh.json` adds a Chinese `meta.description` about recording and managing the session goal.

#### packages/goal/goal/README.md
The domain spec: four durable phases + process-local activation, the seven verbs, the round cap (256), what survives a resume/fork, and the honest limit — "a plugin with direct `Session` access can append counterfeit `goal/change` data … this is integrity detection, not plugin isolation."

#### packages/goal/goal/README.zh.md
Chinese translation of `goal/README.md` (171 lines, same anchors).

#### packages/goal/goal/README.i18n.yaml
Per-heading EN/ZH hashes for `goal/README.md` (37 heading hashes).

#### packages/goal/tool-goal/src/authority.ts
- Purpose: The execution-time authority check that separates "the human asked" from "the machine asked".
- Key abstractions: `GoalToolExecution {agent, events, openTurnStartSeq}`; `GoalToolAuthority` = `direct-human` ∪ `goal-round`.
- Data flow: `goalToolExecution` snapshots `agent.session.snapshotEvents()` and reads the `turnBoundary` projection for `openTurnStartSeq`; `someOpenTurnEvent` scans only the events **after** that boundary.
- Non-obvious design decisions: (a) Authority is proven by a `user/message` whose `source.kind === 'user'` — a host-assigned source, not a caller-supplied one. (b) `hasDirectHumanInput` additionally requires the agent to be a **runtime root** (`ctx.agents.roots().includes(...)`), so a live subagent can never create or edit a goal even if a human message is in its turn. (c) The goal-round authority must match the *exact* admitted round (`goalId`, `revision`, and `round === goal.roundsStarted`) — a forged attribution cannot complete a goal.
- Edge cases / failure handling: Every failure is a `HarnessError` with a stable code: `GOAL_TOOL_AGENT_REQUIRED`, `GOAL_TOOL_DRIVER_REQUIRED`, `GOAL_TOOL_AUTHORITY_REQUIRED`.
- Surprising: The doc comment on `hasDirectHumanInput` records the hazard: "An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human producers must supply their own source rather than inheriting this authority."

#### packages/goal/tool-goal/src/index.ts
- Purpose: Registers `get_goal`, `create_goal`, `update_goal`.
- Key abstractions: One shared `GOAL_VALUE_SCHEMA` + `GOAL_OUTPUT` (canonical compact JSON `{goal: null}` or `{goal:{...}, activation}`); `guidance(blockedAfter)` for the prompt section; `UpdateAction` union.
- Data flow: `ctx.systemPrompt.section({name:'tool:goal', ...})` + three `ctx.tools.register(defineTool(...))`. `update_goal` resolves the ref, checks action-specific argument legality, applies the authority rule, mutates the goal, and — only on an autonomous terminal round — defers a wrap-up context.
- Non-obvious design decisions: (a) The **same** threshold constant is used both in the prompt text and in the hard execution check, so guidance and enforcement cannot drift. (b) Strict-schema empty-string and zero fillers are treated as *omitted* (`hasText` / `hasRoundCap`), so a model that sends `""` for `objective` does not trigger an "invalid edit". (c) `resume` of a **durable paused** goal is refused with `GOAL_TOOL_RESUME_PAUSED` before the service runs — that transition belongs to the human path. (d) The tool result carries `activation` as an *observation*, explicitly "never becomes replay authority".
- Edge cases / failure handling: `blocked` requires a non-empty `blocked_reason` and, during a goal round, at least `blockedAfterConsecutiveRounds` admitted rounds (`GOAL_TOOL_BLOCK_THRESHOLD`); `blocked_reason` with any other action is refused.
- Surprising: `create_goal`'s description tells the model to infer goal intent "even if the user did not say 'goal'" and "in any language" — intent detection is delegated to the model, with only the *authority* enforced in code.

#### packages/goal/tool-goal/src/wrapup.ts
Renders the `<goal_complete>` / `<goal_blocked>` closing instruction (one text block) with a `GROUNDING` clause: "Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it." The doc comment records that this **replaced a former hard turn stop** so the model still addresses the user once before the turn ends.

#### packages/goal/tool-goal/tests/tool-goal.spec.ts
663 lines, 26 cases: registration + disposal, the **args-only** generic render intent, the authority matrix (agentless, driverless, non-human producer, live child, stale agent, wrong initiator), ref freshness, the blocked threshold across admitted rounds, and that a direct-human completion does **not** inject the wrap-up instruction.

#### packages/goal/tool-goal/package.json
Publishes `@deepseek-ai/dsh-tool-goal`; peer-deps dsh-goal/dsh-llm/dsh-system-prompt/dsh-tools/dsh-session-projection.

#### packages/goal/tool-goal/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/llm/core-session/core-agent/core-tools/core-system-prompt/goal/session-projection.

#### packages/goal/tool-goal/README.md
The model-facing contract: the three tools, the authority rules, the wrapped-up autonomous completion, and the honest limits ("execution can prove that the current turn contains a direct human message, not whether the request is substantial enough to merit a goal").

#### packages/goal/tool-goal/README.zh.md
Chinese translation of `tool-goal/README.md` (162 lines, same anchors).

#### packages/goal/tool-goal/README.i18n.yaml
Per-heading EN/ZH hashes for `tool-goal/README.md`.

#### packages/goal/tool-goal/locale/en.json
English UI catalogue: a single `meta.title` ("tool-goal").

#### packages/goal/tool-goal/locale/zh.json
Chinese catalogue with a `meta.description` about the model setting/reading/updating the session goal.

#### packages/goal/command-goal/src/index.ts
- Purpose: The human-facing `/goal` command.
- Key abstractions: `GoalCommand` closed union (`show|create|edit|invalid-edit|pause|resume|clear`); `parseGoalCommand`; `renderGoal`; `commandHint` (which valid commands to suggest per phase/activation).
- Data flow: `ctx.commands.register({name:'goal', input:{hint, attachments:true}})` → parse → `ctx.goals.*` → a `CommandResult` with plain text (never exposing branded ids or revisions).
- Non-obvious design decisions: (a) Control words are recognized **only as the entire input** — `/goal pause after verification` creates that literal objective. (b) `GoalError` is converted into a stable command error, but an *unexpected* failure is rethrown so the adapter reports a command failure rather than a domain result. (c) Attachments are submitted as **one ordinary user followup** (ordered image/file blocks + a fixed text) so later goal rounds read them from ordinary session history — the goal domain stores no attachment state.
- Edge cases / failure handling: Attachments on a non-objective sub-command are refused **before** any domain mutation, leaving the composer's draft and cards intact.
- Surprising: `/goal edit <objective>` on a *complete* goal creates a **new** goal (fresh id, revision 1) rather than editing the tombstoned one.

#### packages/goal/command-goal/tests/command-goal.spec.ts
346 lines: Loader-safe export shape (no `default`, `inject` preserved), the grammar matrix, the phase/activation rendering, `GoalError` → command error, and attachment ordering (`['image','file','text']` with the fixed trailing text).

#### packages/goal/command-goal/package.json
Publishes `@deepseek-ai/dsh-command-goal` 0.2.1-rc.2; peer-deps dsh-commands/dsh-goal/dsh-llm; no runtime dependencies.

#### packages/goal/command-goal/tsconfig.json
Extends `tsconfig.base.json`; project references cordis/cosmokit/commands/llm/goal; emits `lib/types` declarations.

#### packages/goal/command-goal/locale/en.json
English UI catalogue: only `meta.title` ("command-goal"); no other strings are localized here.

#### packages/goal/command-goal/locale/zh.json
Chinese catalogue adds a `meta.description` ("通过用户命令设置和管理当前会话目标。") alongside the translated title.

#### packages/goal/command-goal/README.i18n.yaml
Per-heading EN/ZH content hashes for `command-goal/README.md`, re-recordable with `pnpm run verify-translation-pairing --write packages/goal/command-goal/README.md`.

#### packages/goal/command-goal/README.md
The command reference and grammar rules; notes that "Commands and their direct output stay in the UI and do not enter model requests", and that the Web bundle keeps the goal service and driver on the Host while mounting the command producer per agent preset.

#### packages/goal/command-goal/README.zh.md
Chinese translation of `command-goal/README.md` (140 lines).

#### packages/goal/goal-round-driver/src/index.ts
- Purpose: The automatic same-session continuation driver.
- Key abstractions: `DriverState` (per-Agent serialized state: `attempt`, `competingQueued`, `needsCheckpoint`, `requested`, `run`, `stopping`); `RoundAttempt` (`queued|claimed|admitted`, `cancelled`, `stale`); `RoundIdentity {goalId, revision, round}`.
- Data flow: `agent/status → idle` → `requestDrive` → `drive()` → optional `ctx.sessions.flush()` checkpoint → `ctx.goals.get` → `agent.followup(message)` with a `goal`-sourced user message → `agent/pre-step` validates the reservation → the turn runs → `session/event` marks the attempt admitted → the fold advances `roundsStarted`.
- Non-obvious design decisions: (a) **Reserve-then-admit**: a round is *reserved* at idle but only *consumes* its number when an admitted `user/message` reaches the session log — a rejected reservation does not burn a round. (b) The `agent/pre-step` listener validates the **complete claimed record** (content deep-equality, source, goal id, revision, phase, activation, `round === roundsStarted + 1`) **both before and after** the downstream chain, so a stale or competing prompt is rejected before it can enter history. (c) Every `goal/changed` sets `needsCheckpoint`, so the driver awaits `ctx.sessions.flush()` and **rechecks** before reserving — a durability obligation before scheduling. (d) A host-initiated `pause` while the agent is running **cancels the live turn** (`agent.cancel({kind:'user'},{keepInbox:true})`); a model-initiated pause inside its own turn finishes normally. (e) The pause fence is keyed to the exact attempt's `{goalId, revision}`, so a host pause immediately followed by a resume (which bumps the revision) does not re-pause the resumed goal. (f) `restoreOtherClaimed` re-prepends non-goal claimed messages so dropping one goal round does not strand a human message.
- Edge cases / failure handling: A flush failure arriving via `agent/error` **disarms** continuation instead of retrying; a `turn/end` with reason `max-tokens` disarms; a downstream `reject` blocks the goal with code `prompt-rejected`; a throwing downstream hook clears the reservation so the next pass can reschedule; a queue failure blocks with code `queue-failed`; the round cap blocks with code `round-limit`.
- Surprising: On plugin load the driver **disarms every existing agent** — "Loading a lifecycle driver over existing agents never inherits hidden automatic authority from an earlier producer instance." Teardown closes admission, disarms, cancels active work with the `parent` cause, and awaits the driver plus agent quiescence while the event fence is still installed.

#### packages/goal/goal-round-driver/src/prompt.ts
Renders the one-block `<goal_round>` prompt: `Objective: ${JSON.stringify(goal.objective)}`, `Round: N/max`, and the working instructions ("Treat the current workspace, tool results, and durable session state as authoritative; inspect them instead of assuming earlier narration is still current").

#### packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts
1229 lines over a `ScriptedAdapter` LLM stub that can throw, hang until aborted, or return max-tokens: prompt policy (incl. the tag-injection control), round admission to the cap, cancellation/pause races, checkpoint failures, stale-revision fencing, descendant joins, and the full teardown matrix.

#### packages/goal/goal-round-driver/package.json
Publishes `@deepseek-ai/dsh-goal-round-driver`; marks `@deepseek-ai/dsh-subagent` as an **optional** peer dependency (the driver works without it).

#### packages/goal/goal-round-driver/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/core-agent/goal/llm/core-session/subagent.

#### packages/goal/goal-round-driver/tsdown.config.ts
One tsdown entry: ESM, node platform, es2024 target, `dts: false`, `clean: false`, built from `lib/types/index.js` into `lib`.

#### packages/goal/goal-round-driver/README.md
The driver's spec: what each round does, when continuation stops (nine distinct stop reasons), the reservation/admission rule, the race fences, the durability checkpoint, and the KV-cache note — "Append-only within an epoch: each admitted round extends the existing conversation after its reusable prefix."

#### packages/goal/goal-round-driver/README.zh.md
Chinese translation of the driver README (139 lines).

#### packages/goal/goal-round-driver/README.i18n.yaml
Per-heading EN/ZH hashes for the driver README.

#### packages/goal/goal-round-driver/locale/en.json
English UI catalogue: a single `meta.title` ("goal-round-driver").

#### packages/goal/goal-round-driver/locale/zh.json
Chinese catalogue adds a `meta.description` about continuing the session goal automatically.

---

### packages/skill/ — the skill capability family

#### packages/skill/README.md
Group map for the five skill packages: registry, filesystem provider, bundled Office provider, the model-facing tool, and the workspace-dependencies tool. Notes "model access requires at least one source."

#### packages/skill/README.zh.md
Chinese translation of the skill group map (55 lines).

#### packages/skill/README.i18n.yaml
Per-heading EN/ZH hashes for the skill group map.

#### packages/skill/skill/src/index.ts
- Purpose: `SkillRegistry` (`ctx.skills`) — the Service Definition half of the skill seam.
- Key abstractions: `SkillProvider` (`list`/`get`), `SkillCandidate` (with `rank` and an opaque `locator`), `SkillSummary`, `SkillDefinition`, `SkillInvocationPolicy {modelInvocable, userInvocable}`, `SkillResourceBase` (directory | url | opaque), `SkillProviderControl {signal, invalidate}`.
- Data flow: `registerProvider` → per-scope layer → `list`/`snapshot` → `collect()` merges layers → `get(name)` → provider load → validate → return. `renderSkillContent` is the shared model-facing wrapper.
- Non-obvious design decisions: (a) **Layered scoping** — a registration is filed into the layer of its *calling context's* scope; a read merges the global layer with the viewing scope's chain, and the **nearest layer wins a duplicate name outright** while `rank` only decides duplicates *within* one layer. (b) The collect cache is keyed on `{cwd, scope-chain-ids, revision}` — the chain is part of the key because "a blank-session recompose re-parents an existing scope without touching this registry". (c) A collection that races a revision bump is **retried once** (`MAX_COLLECT_ATTEMPTS = 2`) and then returned **uncached** as an incomplete observation, so a last-good catalog survives. (d) `invalidate()` is **registration-scoped**: it takes effect only while the exact registration is still live, so a late callback cannot disturb a replacement provider with the same name. (e) The registry validates every candidate field *before* caching it, and rejects a provider returning a candidate whose `provider` is not its own name.
- Edge cases / failure handling: A failing provider is logged and skipped and the observation is marked incomplete; `get()` races the provider load against the abort signal and rechecks cancellation **after** a cache hit; a definition whose name differs from the selected candidate invalidates the cache and returns `undefined`; `toError`/`errorMessage` contain a hostile `Symbol.toPrimitive` or a throwing proxy.
- Surprising: **Definitions are never cached** — every load asks the provider for the current body, so a body edit needs no versioning. `renderSkillContent` embeds the body *verbatim* ("skills are trusted local content") while escaping only the attribute and the resource hint.

#### packages/skill/skill/tests/skill.spec.ts
~1270 lines, 46 cases: duplicate first-wins resolution, every malformed candidate/definition scalar, abort races (including a hostile abort *reason*), cache invalidation from a live provider vs. an ignored late callback, synchronous/asynchronous observer failures, the in-flight retry/bound, and the whole scoped-layer matrix (nearest layer wins regardless of rank; scope-chain recompose; per-layer provider-name uniqueness).

#### packages/skill/skill/package.json
Publishes `@deepseek-ai/dsh-skill`; peer-deps dsh-llm/dsh-scope; deps dsh-util-values and schemastery.

#### packages/skill/skill/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/core-scope/llm/util-values.

#### packages/skill/skill/locale/en.json
English UI catalogue: a single `meta.title` ("skill").

#### packages/skill/skill/locale/zh.json
Chinese catalogue with a `meta.description` about aggregating skills from different sources.

#### packages/skill/skill/README.i18n.yaml
Per-heading EN/ZH hashes for `skill/README.md`.

#### packages/skill/skill/README.md
The registry spec: the provider contract, the layer-shadowing rule, "The registry has no TTL: only a provider calling its registration-scoped `invalidate()` … clears completed catalogs", and the four invocation-policy combinations in a table.

#### packages/skill/skill/README.zh.md
Chinese translation of `skill/README.md` (150 lines).

#### packages/skill/skill-filesystem/src/index.ts
- Purpose: The local filesystem skill provider.
- Key abstractions: `SkillRoot {path, source, rank, skipSystem?, projectRoot?, trustedHost?}`; `FileSystemSkillProvider`; `SkillWatchManager`; `ParsedSkill`; `LocalLocator {path, directory}`.
- Data flow: `list(options)` → resolve roots (project `.dsh/skills` + `.agents/skills`, custom dirs, `~/.dsh/skills`, `~/.agents/skills`, bundled) → `discoverRoot` per root (directory bundle `<name>/SKILL.md` or flat `<name>.md`) → parse frontmatter → candidate with the root's rank → registry merge. `get(candidate)` re-reads the file.
- Non-obvious design decisions: (a) **Catalog and body have separate lifecycles** — discovery parses frontmatter into the summary, but every load re-reads the file, so body edits need no hash or cache invalidation. (b) **Discovery and watching are separate**: `list()` scans the filesystem; a separate manager owns Chokidar handles, missing-root probes and invalidation. (c) The watcher is **bounded** (`watchMaxProjects`, default 128) and evicts the oldest project. (d) A missing root is watched from its nearest existing ancestor **one path segment at a time** with `fs.watchFile`, so a root created later is detected. (e) First-party `write`/`edit` mutations invalidate **synchronously** through the `fs/observed` event, so the model sees its own write without waiting for the OS watcher. (f) A `trustedHost` root (the bundled skill dir) bypasses `ctx.fs` and reads through Node, so the host's own assets are not sandboxed.
- Edge cases / failure handling: A malformed skill file is **skipped with a warning**, not surfaced to the model (so the model cannot distinguish absent from invalid); a transient read failure marks the observation **incomplete** rather than replacing the last-good catalog with a misleading deletion; an unparseable invocation value drops the whole skill; `resolveRootWatchMode` tolerates ENOENT/ENOTDIR while walking up.
- Surprising: `parseInvocationPolicy` **rejects the legacy keys** (`disableModelInvocation`, `modelInvocable`, `userInvocable`) outright with "use X instead" — a stale frontmatter fails loudly instead of silently permitting a surface. The boolean grammar accepts `true/false/yes/no/on/off/1/0` case-insensitively and anything else throws.

#### packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts
~860 lines, 20 cases: root priority order and shadowing, flat-skill parsing, the documented boolean spellings, legacy-key rejection, CRLF frontmatter and delimiter-looking text inside YAML values, symlinked skills publishing regular-file paths, `ctx.fs` vs. Node discovery parity, transient-vs-confirmed disappearance, cancellation forwarding, watcher refresh of additions/deletions/recreated roots, `fs/observed` invalidation without a watcher, the project-watch cap, and disposal containment.

#### packages/skill/skill-filesystem/tests/skill-filesystem-watcher.spec.ts
Watcher-failure spec (11 cases): root canonicalisation, symlink preservation when link-following is off, missing-path probes that ignore unchanged paths, skills staying loadable across persistent startup failures, event filtering + coalescing + runtime-error recovery + late callbacks, watcher replacement on `unlinkDir`, immediate re-creation observation, and the three disposal-race variants.

#### packages/skill/skill-filesystem/package.json
Publishes `@deepseek-ai/dsh-skill-filesystem`; runtime deps chokidar 5.0.0 and yaml; peer-deps dsh-skill/dsh-fs/dsh-home-paths.

#### packages/skill/skill-filesystem/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/fs/home-paths/skill.

#### packages/skill/skill-filesystem/locale/en.json
English UI catalogue: a single `meta.title` ("skill-filesystem").

#### packages/skill/skill-filesystem/locale/zh.json
Chinese catalogue with a `meta.description` about discovering and reading skills from local directories.

#### packages/skill/skill-filesystem/README.i18n.yaml
Per-heading EN/ZH hashes for `skill-filesystem/README.md`.

#### packages/skill/skill-filesystem/README.md
The provider spec: the skill file format, the **five-rank root table** (100 project-dsh → 500 user-agents, bundled 600), the frontmatter grammar, the change-detection split (watcher for external changes, `fs/observed` for first-party ones), and the stated limits ("Discovery is one level deep").

#### packages/skill/skill-filesystem/README.zh.md
Chinese translation of `skill-filesystem/README.md` (161 lines).

#### packages/skill/skill-office/src/index.ts
- Purpose: Registers the seven bundled Office skills as one provider.
- Key abstractions: `SKILL_NAMES` (office, office-docx, office-pptx, office-xlsx, office-render, office-recalculate, office-export-pdf); `parseSkill`; `officeRuntime(config)`.
- Data flow: At registration the provider reads each `SKILL.md`'s frontmatter to get the description; at load it re-reads the body and, for the three operation skills, **appends** the absolute Node + LibreOffice Kit CLI paths.
- Non-obvious design decisions: (a) Descriptions are read at *registration* (so the catalogue is cheap) and bodies at *load* (so edits apply immediately). (b) The interpreter/CLI paths are appended **only when an operation skill is loaded**, so the authoring skills never carry renderer vocabulary — which is what keeps the progressive-loading test green (`requests[1]` has no `dsoffice`). (c) The resource base path is normalised to forward slashes.
- Edge cases / failure handling: A packaged app (Electron or SEA) **must** supply a standalone Node executable — otherwise it throws; the CLI and Node paths must be absolute existing files; `cli: false` disables the runtime and injects "LibreOffice Kit is disabled in this deployment."
- Surprising: `officeRuntime` resolves the CLI through `import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json')` — the skill package hard-depends on the renderer.

#### packages/skill/skill-office/assets/office/SKILL.md
The 15-line **router** skill: maps task type to the six sub-skills, says "Images, visual inspection, or tasks primarily about layout, spacing, sizing, or alignment: `office-render`, **even without an explicit visual-check request**", honours "requests to skip rendering", and ends with "Do not reload skills."

#### packages/skill/skill-office/assets/office-docx/SKILL.md
The Word skill: use `python-docx`; do not install packages or hunt for a system Python; keep scripts in the task workspace and name them so they do not shadow imports ("avoid module names such as `inspect.py`, `docx.py`, or `zipfile.py`"); "assigning paragraph `.text` destroys run formatting"; CJK text needs an explicit `w:eastAsia` font; and the ZIP-member trap — "create a new ZIP and copy each unchanged member once; appending a replacement member duplicates its name and corrupts the package."

#### packages/skill/skill-office/assets/office-pptx/SKILL.md
The PowerPoint skill: `python-pptx` usage, an editable-deck code sample, "Paragraph alignment does not move a text box", the native chart's embedded workbook is part of the deliverable, and the delivery step via `present({"files":[...]})`.

#### packages/skill/skill-office/assets/office-xlsx/SKILL.md
The Excel skill: `openpyxl` for edits, `pandas` for analysis but "a DataFrame is not the workbook"; `data_only=False` to keep formulas; "writing a formula does not calculate its result"; do not rename `.xls`/`.xlsb`/encrypted/macro files to `.xlsx`; and the rule that appearance edits (cell fills, alignment) require `office-render` while bold headers do not.

#### packages/skill/skill-office/assets/office-render/SKILL.md
The render skill: private `mktemp -d "./.dsh-office.XXXXXXXX"` preview directories (POSIX) or a GUID-named parent under the workspace (PowerShell), never a fixed name; the blank-image detection (composite RGBA onto white first — "raw RGB under transparent pixels can look nonblank"); "Check once and do not reread the same image"; and the exact required sentence when inspection stops: *"Content and structure checks passed; visual inspection was not completed."*

#### packages/skill/skill-office/assets/office-recalculate/SKILL.md
The recalculation skill: the CLI form, verification with **both** `data_only=False` and `data_only=True`, "do not replace requested formulas with constants or present stale/absent caches as fresh results", and preserving the workbook if no engine is available.

#### packages/skill/skill-office/assets/office-export-pdf/SKILL.md
The PDF skill: convert, check the command result and the `%PDF-` signature, and only that — "do not search for PDF readers, generate images, or install tools to validate a conversion".

#### packages/skill/skill-office/assets/office/references/sidecar.md
The missing-sidecar reference: a missing `dsoffice` on PATH does not prove absence; ask the user before downloading; install with `--ignore-scripts` into a task-local tools directory with a writable package-manager cache; a per-platform engine table ending in the WASM fallback; "Permission to download the Office sidecar does not include installing Python, Node.js, or a package manager"; and "do not assume installation changed the session's PATH".

#### packages/skill/skill-office/tests/progressive-loading.spec.ts
The progressive-loading proof: a `MockAdapter` scripted with `skill` calls; asserts the **router** request contains the summary but not `python-docx`, the **authoring** request contains `python-docx` but not `dsoffice`, and that resume and fork retain the loaded instructions in later requests — in both `native` and `ptc` tool modes.

#### packages/skill/skill-office/tests/skill-office.spec.ts
Provider spec: the routing/authoring context budgets, loading each packaged body and removing all candidates on disposal, loading **relocated** resources through a real `cordis.yml` composition, rejecting relative resource paths and incomplete asset trees before registration, executing `capabilities` using only the paths the loaded skill returned, and validating operation paths at load while authoring stays available.

#### packages/skill/skill-office/tests/docx-validation.e2e.ts
Live-API e2e (skipped unless `DEEPSEEK_API_KEY` and `DSH_PRIMARY_RUNTIME` are set): a Word content edit through the shipped headless CLI, asserting the transcript contains no render-only vocabulary.

#### packages/skill/skill-office/tests/render-tools.e2e.ts
Live e2e of actual skill discovery **and** real CLI rendering through the shipped headless composition, with the fixture CLI recording operations.

#### packages/skill/skill-office/tests/visual-intent.e2e.ts
Live e2e over explicit, excluded and **implicit** visual inspection across pptx/xlsx/docx tasks — the file that pins "appearance changes require rendering even without an explicit visual-check request".

#### packages/skill/skill-office/tests/xlsx-validation.e2e.ts
Live e2e of real-agent Excel validation through the headless profile using the built primary runtime, including reading back the rendered images.

#### packages/skill/skill-office/tests/fixtures/real-office.ts
Shared fixture: `officeModelPatches()` (a real DeepSeek provider patch, or an OpenAI-completions variant when `DSH_OFFICE_TEST_API` says so) and `expectNoRenderContext(events)`, which derives the session messages and asserts they contain **none** of `imageRendering|maxPixels|fragment rectangles|render --input|--output-dir|uniformly blank`.

#### packages/skill/skill-office/tests/fixtures/render-cli.ts
Fixture that writes a Node CLI wrapper around the real `@deepseek-ai/libreoffice-kit/cli`, logs every invocation to a JSONL file, and runs a **Python/PIL** script that composites RGBA onto white before deciding whether the render is blank.

#### packages/skill/skill-office/tests/fixtures/encrypted.xlsx
**Skipped** — see "Files skipped" below.

#### packages/skill/skill-office/tests/fixtures/encrypted.xlsx
**Skipped** (see "Files skipped" below): a 224-byte binary ZIP stub whose only entry is an 8-byte `[Content_Types].xml`, standing in for an encrypted workbook; it is referenced by no test in this package.

#### packages/skill/skill-office/package.json
Publishes `@deepseek-ai/dsh-skill-office`; ships the `assets/` tree; runtime dep `@deepseek-ai/libreoffice-kit ^0.1.5`.

#### packages/skill/skill-office/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/skill.

#### packages/skill/skill-office/README.md
Documents the seven Office skills, the progressive-loading decision tree (mermaid), and the character-based token budget estimates.

#### packages/skill/skill-office/README.zh.md
Chinese translation of `skill-office/README.md` (136 lines, same anchors).

#### packages/skill/skill-office/README.i18n.yaml
Per-heading EN/ZH hashes for `skill-office/README.md`.

#### packages/skill/tool-skill/src/index.ts
- Purpose: The model-facing `skill` loader tool and the durable session skill catalog.
- Key abstractions: `SkillCatalogSource {kind:'skill-catalog', form:'catalog', update?: true, entries}`; `renderCatalogMessage` / `renderCatalogUpdate`; `digestCatalogEntries`; `catalogHistory`; `catalogMessage`; `readCatalogEntries`; `invokedSkillNames`; the `SKILL_GESTURE` regex.
- Data flow: At each `agent/pre-step` the plugin snapshots the catalog for the calling agent's scope/cwd, filters to model-invocable skills, digests the entries, compares against the newest **visible** `skill-catalog` message in the session log, and either leaves history alone or appends/replaces a complete catalog message. A second listener injects `/name`-invoked skill bodies.
- Non-obvious design decisions: (a) The catalog is a **durable projection**, diffed by a digest over the published *entries*, not over the rendered prose — so the `<system-reminder>` framing can never force a republish and consumers never re-parse the `<available_skills>` block. (b) The digest is computed over `JSON.stringify([name, description])` per entry joined by `\n`, because "every separator is itself a legal description character, so only quoting makes the boundary exact". (c) The **catalog source records the entries it published** — the fact is stored, the prose is derived. (d) The visibility check compares `ctx.tools.get(skillTool.name, agent) === skillTool` — *definition identity*, not name — so a scoped same-name shadow removes both the schema and its guidance. (e) An **incomplete** provider snapshot emits nothing and preserves the last-good catalog. (f) The `/name` gesture scans **only** `source.kind === 'user'` messages, so external text cannot forge the gesture, and the check runs on the *loaded* definition (unknown or user-disabled names stay ordinary prose). (g) The gesture regex requires whitespace boundaries, which keeps `/usr/bin` and `5/8` out.
- Edge cases / failure handling: A malformed durable catalog record is treated as "not a catalog" rather than throwing inside the step listener ("would fail every subsequent turn of that session"); a session event below the current length throws explicitly; the tool returns distinct errors for invalid name, unknown skill, and model-disabled skill.
- Surprising: The **empty** catalog is published deliberately — it "retires" earlier names so the model does not call a skill that was removed. The catalog's closing sentence tells the model that a user-invoked skill arrives as a `<skill_content>` block and it must **not** call the tool again for it.

#### packages/skill/tool-skill/tests/tool-skill.spec.ts
~1120 lines, 34 cases: the tool schema and disposal, abort forwarding, the initial catalog, "no catalog when no model-invocable skills", the incomplete-observation retry, the empty baseline, dedup/replace within one step, the stale-proposal removal, the addition/removal replacement catalogs, resumption from durable entries, the malformed-durable-record tolerance, the compaction-hidden-catalog re-establishment, "body-only edits stay out of the catalog", layered registry resolution, the last-good catalog retention, tool visibility scoping (restriction and shadow), the description cap, the loader's cwd/policy checks, and the full gesture matrix.

#### packages/skill/tool-skill/package.json
Publishes `@deepseek-ai/dsh-tool-skill`; peer-deps dsh-skill/dsh-tools/dsh-llm/dsh-working-directory.

#### packages/skill/tool-skill/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/core-scope/llm/core-agent/skill/core-tools/session-working-directory.

#### packages/skill/tool-skill/locale/en.json
English UI catalogue: a single `meta.title` ("tool-skill").

#### packages/skill/tool-skill/locale/zh.json
Chinese catalogue with a `meta.description` about letting the AI load skill instructions on demand.

#### packages/skill/tool-skill/README.i18n.yaml
Per-heading EN/ZH hashes for `tool-skill/README.md`, including the quoted catalog and result templates.

#### packages/skill/tool-skill/README.md
The catalog spec with the exact **catalog template** and **result template** quoted, the token-effect and KV-cache-effect statements per surface, and the honest limits ("Loaded instruction bodies have no size cap"; "Catalog replacement is whole-list").

#### packages/skill/tool-skill/README.zh.md
Chinese translation of `tool-skill/README.md` (259 lines).

#### packages/skill/tool-workspace-dependencies/src/index.ts
- Purpose: The `load_workspace_dependencies` tool — where the bundled Python/Node/pnpm live.
- Key abstractions: `PrimaryRuntimeManifest` (with `payloadDigest`); `WorkspaceDependencies`; `parsePrimaryRuntime`; `readPrimaryRuntime`; `primaryRuntimePythonAliases`; `copyPrimaryRuntime`; `workspaceDependencyPaths`; `resolvePrimaryRuntime`; `installPrimaryRuntime`.
- Data flow: First call → `installPrimaryRuntime(source, root)` (or `resolvePrimaryRuntime(source)` when no root) → memoized promise → the tool result carries absolute paths plus `pythonDistributions`.
- Non-obvious design decisions: (a) **Manifest validation owns the truth** — the legacy `components` format is normalised in memory (never rewritten on disk) and a *mixed* legacy/flat manifest is rejected. (b) Distribution names are normalised (`Numpy`/`PANDAS` → `numpy`) and a collision is rejected. (c) The install is **staged**: copy into `mkdtemp`, validate the staged entries, rename the old root to `.previous`, rename staging into place, and **roll back** if the swap fails. (d) The first-party Python aliases (`python`, `python3` → `python3.12`) are the only symlinks preserved across a copy; every other link is materialised, and an alias that does not point directly at the versioned regular file is rejected.
- Edge cases / failure handling: An incompatible platform/arch is refused; a payload whose entry kinds are wrong (file vs directory) is refused at every mode; a symlinked install root is refused without touching its target; a failed preparation resets the memo so the next call retries; disposal waits for pending filesystem work but never fails.
- Surprising: `installPrimaryRuntime` reuses an installed payload when the manifest is byte-identical, so a user's extra packages in the installed tree survive an upgrade of the same release.

#### packages/skill/tool-workspace-dependencies/tests/tool-workspace-dependencies.spec.ts
~480 lines, 30 cases: platform paths, offline install + reuse without touching the environment, Windows payloads creating no aliases, an unreadable alias aborting a partial payload, release-component replacement and recovery of an interrupted swap, digest-only payload replacement, keeping the installed release when the replacement is incomplete, refusing a linked install directory, malformed/incompatible metadata, legacy metadata without a distribution map, rollback on publication failure, retry after a failed preparation, disposal waiting for pending preparation, and the whole malformed-metadata table.

#### packages/skill/tool-workspace-dependencies/tests/primary-runtime-copy.spec.ts
Target-specific copy spec: linux/darwin/win32 layouts, and rejection of absolute, escaping, chained, dangling and directory aliases before any copy happens.

#### packages/skill/tool-workspace-dependencies/package.json
Publishes `@deepseek-ai/dsh-tool-workspace-dependencies`; no runtime deps beyond schemastery; ships only `lib` output.

#### packages/skill/tool-workspace-dependencies/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/core-tools.

#### packages/skill/tool-workspace-dependencies/README.md
Documents the `runtime.json` payload schema, the carrier payload build, in-place vs installed modes, and the python alias rules.

#### packages/skill/tool-workspace-dependencies/README.zh.md
Chinese translation of `tool-workspace-dependencies/README.md` (127 lines, same anchors).

#### packages/skill/tool-workspace-dependencies/README.i18n.yaml
Per-heading EN/ZH hashes for `tool-workspace-dependencies/README.md`.

---

### packages/spill/ — the text-spill capability family

#### packages/spill/README.md
Group map: the storage service, the local backend, and the tool-result policy. Notes that tool-result spilling is **opt-in** through `maxInlineTokens` and keeps the original result on storage failure.

#### packages/spill/README.zh.md
Chinese translation of the spill group map (51 lines).

#### packages/spill/README.i18n.yaml
Per-heading EN/ZH hashes for the spill group map.

#### packages/spill/spill/src/index.ts
The abstract `SpillStore extends Service` (`ctx.spillStore`) with exactly **one** method, `saveText(input: SaveTextSpill): Promise<SpillRef>`. The doc comment states the semantics every implementation must honour: full content verbatim, a session-scoped private location, a collision-free name derived from — never equal to — `suggestedName`, and **rejection on real storage failure** ("the caller decides how to degrade").

#### packages/spill/spill/src/types.ts
The spill vocabulary: branded `SpillLocator`; `SpillOwner {sessionId}`; `SpillSource` = tool (`toolName`, `callId`, `label`) ∪ session-reference (`sessionId`, `label`); `SaveTextSpill`; `SpillRef {locator, bytes, retrievalHint}`. Documents that forked sessions inherit locators without copying or re-owning them, and that the locator is opaque to consumers.

#### packages/spill/spill/tests/service.spec.ts
Seam-only spec (3 cases): a minimal concrete subclass registers as `ctx.spillStore`, a second load throws (duplicate service), and disposal releases it. The header comment states storage behaviour is deliberately out of scope here.

#### packages/spill/spill/package.json
Publishes `@deepseek-ai/dsh-spill`; peer-deps brand/llm/session; contributes only the abstract service and its types.

#### packages/spill/spill/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/brand/llm/core-session.

#### packages/spill/spill/README.md
Service spec: one-method `saveText` contract, ownership vs source separation, rejection-on-real-failure, and the no-retention/no-retrieval boundary.

#### packages/spill/spill/README.zh.md
Chinese translation of `spill/README.md` (154 lines, same anchors).

#### packages/spill/spill/README.i18n.yaml
Per-heading EN/ZH hashes for `spill/README.md`.

#### packages/spill/spill-local/src/store.ts
- Purpose: The Cordis-free storage mechanics.
- Key abstractions: `encodeSegment`, `sessionDir`, `saveTextFile`, `privateRoot`, `DEFAULT_ROOT_PREFIX`.
- Data flow: `sessionDir(root, sessionId)` = `session-<sha256(sessionId)[0..12]>`; the file name is `<randomBytes(6).hex>-<encodeSegment(suggestedName)>`; the file is created with `open(path, 'wx', 0o600)` in a `mkdir(..., {mode:0o700})` directory.
- Non-obvious design decisions: `encodeSegment` is an **injective encoding over all JS strings** — every character outside `[A-Za-z0-9._-]` (and `~` itself) becomes `~XXXX`, so `../`, absolute paths, NUL and separators can never escape one segment; the whole-segment tokens `.` and `..` are escaped too, and the empty string encodes to `~` (never an empty segment). The `wx` flag makes the write **exclusive**, so a pre-planted symlink or file cannot redirect it.
- Edge cases / failure handling: An `ENOENT` between `mkdir` and `open` retries the loop; the root is a lazily-created private `mkdtemp` under the OS temp dir.
- Surprising: The whole-segment `.`/`..` escape is the exact kind of detail that is usually missed in path sanitisation.

#### packages/spill/spill-local/src/cleanup.ts
- Purpose: The one-shot startup age sweep.
- Key abstractions: `sweepSpillRoots`, `gatherSweepRoots`, `discoverDefaultRoots`, `SweepRoot {path, pruneWhenEmpty}`, `WarnFn`.
- Data flow: gather trusted roots → per root, descend only into `session-<12 hex>` directories → `lstat` each entry → delete regular files with `mtimeMs < cutoff` → prune emptied session dirs → prune an emptied *discovered* default root.
- Non-obvious design decisions: (a) Roots and session dirs are matched by **exact shape regexes** (`^dsh-spill-[A-Za-z0-9]{6}$`, `^session-[0-9a-f]{12}$`), so a `dsh-spill-test-*` fixture or a `session-backup` sibling is never swept. (b) Symlinks are **never followed** — `lstat` only, and a `session-*` symlink is skipped so the sweep cannot delete in a foreign target. (c) On POSIX a root must be owned by the current user, not group/other-writable, and its **ancestors** must be protected (a sticky `/tmp` is allowed). (d) Filesystem **identity** (dev:ino, or lowercased path on Windows) de-duplicates aliases, and the active root is always non-prunable. (e) The cutoff is *strictly* older, so a file exactly at the boundary is kept.
- Edge cases / failure handling: Every filesystem and warning-sink failure is contained (`warnSafely` swallows even a throwing logger); a missing root is silent; a concurrent write recreates a session dir.
- Surprising: The active root is never pruned even when empty, but a *discovered prior* default root is — otherwise one empty root accumulates per past process forever.

#### packages/spill/spill-local/src/index.ts
`LocalSpillStore`: config (`root`, `cleanupPeriodDays` default 30, `0` disables), the fixed-at-construction root, and the fiber-owned cleanup sweep — launched **without awaiting it** at activation (so availability is never delayed) but **awaited on disposal** (so no sweep I/O outlives the fiber). `saveText` returns the path as the locator plus the exact UTF-8 byte count and the retrieval hint "Use read with offset/limit, or grep this path to search within it."

#### packages/spill/spill-local/tests/spill-local.spec.ts
~580 lines, 40 cases: `encodeSegment` edge cases, `sessionDir` stability, `saveTextFile` traversal sanitisation, POSIX 0700/0600 permissions, distinct paths for identical names, root resolution, cleanup-period validation, and the whole sweep-safety matrix (boundary file kept, symlinks skipped, `session-backup` not swept, POSIX foreign-user session dirs skipped, discovered-vs-active pruning, alias de-duplication, quiescence on disposal, contained unsafe roots).

#### packages/spill/spill-local/tests/loader-composition.spec.ts
Real `cordis.yml` composition loaded through the vendored Loader: proves `cleanupPeriodDays` is applied and only expired session contents are pruned.

#### packages/spill/spill-local/package.json
Publishes `@deepseek-ai/dsh-spill-local`; peer-dep dsh-spill; no runtime deps beyond schemastery.

#### packages/spill/spill-local/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/spill.

#### packages/spill/spill-local/locale/en.json
English UI catalogue: a single `meta.title` ("spill-local").

#### packages/spill/spill-local/locale/zh.json
Chinese catalogue with a `meta.description` about saving overlong tool results to session-local files.

#### packages/spill/spill-local/README.md
Backend spec: private 0700 root, session hash dirs, unpredictable names, the startup sweep rules, and the POSIX ancestor-safety checks.

#### packages/spill/spill-local/README.zh.md
Chinese translation of `spill-local/README.md` (141 lines, same anchors).

#### packages/spill/spill-local/README.i18n.yaml
Per-heading EN/ZH hashes for `spill-local/README.md`.

#### packages/spill/spill-policy/src/retention.ts
- Purpose: The pure ordered head/tail retention function.
- Key abstractions: `RetainableBlock` (text ∪ image); `RetainedContent {head, tail, omittedBytes, omittedImages}`; `textSlice`; `fitText`.
- Data flow: `retainContent(content, budget, price)` → half the budget to the head, half to the tail → whole blocks that fit; a text block that does not fit is binary-searched for its longest fitting prefix (or suffix) → the omitted bytes/images are computed by subtraction.
- Non-obvious design decisions: (a) **Images are indivisible** — unused space at an image boundary stays unused, and an image in the omitted interval is omitted too. (b) The head and tail never overlap: when the tail reaches the same block the head consumed, it takes the text *after* the head's cut. (c) `textSlice` refuses to cut between a UTF-16 surrogate pair. (d) Pricing must be monotonic in retained length — binary search assumes it.
- Edge cases / failure handling: A budget consumed entirely by the notices yields an empty retention; a text block whose minimum framing cost exceeds the remaining budget is dropped rather than partially retained.
- Surprising: The omission quantities are **exact** — `omittedBytes` is a subtraction, not an estimate — which is what lets the notice say "Omitted N bytes" truthfully.

#### packages/spill/spill-policy/src/index.ts
- Purpose: The retention policy plugin.
- Key abstractions: `Config {maxInlineTokens}`; `pricing(exec, images)`; `fullText(content)`; `bound(exec, content, toolName, callId, label)`; the two waterfall listeners.
- Data flow: `tools/post-execute` → `await next()` → if accepted and not value-replaced → price the content → if over budget → spill the **full** text through `ctx.spillStore.saveText` → reserve the worst-case notice → `retainContent` with the remainder → return the merged head/`[...]`/tail/footer. `tools/ptc-dispatch-log` uses the same helper for the durable log copy.
- Non-obvious design decisions: (a) The listener is registered with `{prepend: true}` so it bounds content **after** earlier projections but **before** the generic cap. (b) The budget is reserved for the **worst-case** notice *before* the content is split, so the replacement can never exceed `maxInlineTokens` because of a long locator. (c) Image cost uses the **active route's** `imageRequestPricing` (including descriptor text), not a flat estimate; a missing calculator is a best-effort failure, not a guess. (d) The spilled file records each image's **readable attachment path** so the model can `read` the file and then `read_image` the image — attachment bytes are never copied into the file. (e) `read` is explicitly skipped (`exec.name === 'read'`) to avoid a read → spill → read loop. (f) Adjacent text blocks are merged so the framing cost is paid once.
- Edge cases / failure handling: Every failure (no owner, no backend, storage failure, no pricing calculator, no readable image path) logs a warning and **keeps the original content** — a spill failure never turns a successful tool call into an error. If the notice alone exceeds the cap, the original stays inline (and the backend has already saved an unreferenced spill — a documented wart).
- Surprising: The policy only sees *final accepted* content; provider-side truncation and tool-owned output limits happen before it and are outside its scope.

#### packages/spill/spill-policy/src/notice.ts
Browser-safe notice formatting and recognition. `formatSpillNotice` emits `(Omitted N bytes. Full formatted result stored at: <locator>. <hint>)` plus an optional " Omitted M images."; `hasSpillNotice` recognises the historical byte-only spelling *and* the new image-count form by parsing the omission phrase with `describeOmitted` rather than by pattern-matching the whole sentence. The header comment is honest: "This identifies the text convention, not authenticated tool-output origin."

#### packages/spill/spill-policy/src/types.ts
`SpillPolicyExec` — a *structural* view of a tool execution that needs only `agent.session.header.id`, so the policy imports neither dsh-tools nor dsh-agent.

#### packages/spill/spill-policy/tests/spill-policy.spec.ts
~620 lines, 26 cases: disabled mode (no listener at all), export shape, cap validation, the oversized-text replacement, the notice-only fallback, small/non-text results passing through, the outer PTC failure capture, the `read` skip, the dispatch-log arm (including "a slow spill backend never delays the program value" and "a sustained slow backend backpressures the run instead of accumulating unbounded log tasks"), the nested-call skip, the three best-effort fallbacks, downstream-listener composition (a downstream value replacement passes through untouched), and disposal.

#### packages/spill/spill-policy/tests/retention.spec.ts
Retention spec: both images kept in their original positions around a truncated middle text, a middle image omitted with its surrounding text, an image that cannot fit wholly never crossed, no head/tail duplication, everything omitted when the notices eat the budget, and surrogate pairs never split at either end.

#### packages/spill/spill-policy/tests/notice.spec.ts
Notice spec: the historical spelling is preserved independently of the formatter, every omission form the producer can format is recognised, whole-image omissions are reported while historical notices still parse, locator/retrieval text stays opaque (parentheses and newlines), and ordinary/partial/non-final/malformed text is rejected.

#### packages/spill/spill-policy/tests/multimodal.spec.ts
Multimodal spec: ordered end images retained, a middle image omitted whole (its address still in the recovery file), and the original images preserved when the recovery path cannot be resolved, when the route has no visual-token calculator, when the execution filesystem is unmounted, or when the calculator loses an occurrence.

#### packages/spill/spill-policy/tests/multimodal-recovery.spec.ts
Real attachments + filesystem + Node PTC + DeepSeek request bytes: a large single image stays inside a fresh 12 500-token budget, two distinct end images survive in both the tool result and the request, and an omitted middle image is recovered through `read` + `read_image` into the next request.

#### packages/spill/spill-policy/package.json
Publishes `@deepseek-ai/dsh-spill-policy` with a separate `./notice` export subpath for browser consumers.

#### packages/spill/spill-policy/tsconfig.json
Extends `tsconfig.base.json`; references output-retention/llm/core-session/spill/core-tools/attachment/fs/token-meter.

#### packages/spill/spill-policy/locale/en.json
English UI catalogue: a single `meta.title` ("spill-policy").

#### packages/spill/spill-policy/locale/zh.json
Chinese catalogue with a `meta.description` about limiting tool-result length while keeping a path to the full result.

#### packages/spill/spill-policy/README.md
Spec of the retention policy: shared text/image token budget, head/tail split, the notice format, the read skip, and best-effort degradation.

#### packages/spill/spill-policy/README.zh.md
Chinese translation of `spill-policy/README.md` (166 lines, same anchors).

#### packages/spill/spill-policy/README.i18n.yaml
Per-heading EN/ZH hashes for `spill-policy/README.md`.

---

### packages/todo/ — the session task list

#### packages/todo/README.md
Group map: one package (`tool-todo`), the whole-list replacement rule, single-owner scope, and the note that "Interactive hosts show the standing plan from the list, while the group itself ships no UI."

#### packages/todo/README.zh.md
Chinese translation of the todo group map (49 lines).

#### packages/todo/README.i18n.yaml
Per-heading EN/ZH hashes for the todo group map.

#### packages/todo/tool-todo/src/types.ts
`TodoItem {content, status}` and the single declaration of the `todos` projection key plus the `todo/write` session event. The comment explains the deliberately minimal shape: "No id, priority, or `activeForm` — the list is replaced wholesale on every write (last-write-wins), so entries need no stable identity."

#### packages/todo/tool-todo/src/index.ts
- Purpose: The `todo_write` tool and the `todos` session projection.
- Key abstractions: `Config {allowParallelInProgress}`; `describe(allowParallel)`; `toTodoList`; `todosProjectionSchema`; the `todos` projection definition (stateVersion 2).
- Data flow: `todo_write` → schema validation (strict `additionalProperties: false` on items) → `toTodoList` (trim, non-empty, unique, in-progress cap) → `session.append('todo/write', {todos})` → the projection serves the latest whole list; the tool returns the counts.
- Non-obvious design decisions: (a) The deployment policy is a **required** config key with no default, because "the tool cannot observe runtime concurrency" — the flag selects both the enforced cap *and* the wording of the model description. (b) The stored `content` is the **trimmed** value, so the dedupe/length key and the durable snapshot agree. (c) The projection is a **standing plan**: `todo/write` sets the list, `turn/start` clears it, `turn/end` keeps the finished checklist visible. (d) A non-agent caller is **rejected** rather than silently no-op'ing.
- Edge cases / failure handling: Empty content, duplicate content, and (with the flag false) more than one `in_progress` all throw with stable messages; unknown item keys are rejected by the schema so "the logged snapshot must equal what the model believes it wrote".
- Surprising: The tool result is a **fixed one-line string** ("Updated todo list: N pending, M in progress, K completed.") rather than a JSON blob — deliberate token economy.

#### packages/todo/tool-todo/src/client.ts
Ten-line pure re-export of `./types.ts` for client aggregates (zero duplication).

#### packages/todo/tool-todo/tests/tool-todo.spec.ts
~300 lines, 20 cases: the schema shape, the whole-list append and replacement, trimmed storage, dedupe, the parallel-policy matrix (false rejects several, accepts one; true accepts the list false rejects; the description clause follows the flag), the non-agent rejection, the presentation, the HMR disposal, the namespace export shape, and the event's isolation from later mutation plus its seeded-replay round-trip.

#### packages/todo/tool-todo/tests/projection.spec.ts
The projection provider spec (the session-projection RFC's "a fourth domain is just its own registrations" acceptance probe): null before the first write, the whole list with a consistent `asOfSeq`, cleared on the next `turn/start`, no `todos` key when the package is absent, and key removal on fiber unload.

#### packages/todo/tool-todo/tests/integration.spec.ts
Through the real agent loop with a `MockAdapter`: a model `todo_write` call produces a `tool/call`, a **non-error** `tool/result`, and a `todo/write` snapshot; a second write replaces the list.

#### packages/todo/tool-todo/tests/loader-composition.spec.ts
Proves `allowParallelInProgress` is real configurability, not a constant: a `cordis.yml` booted through the real Loader, and both faces it controls — the model-facing description and the accepted input — follow the flag.

#### packages/todo/tool-todo/package.json
Publishes `@deepseek-ai/dsh-tool-todo` with a `./client` export subpath and zod 4.4.3 for the projection schema.

#### packages/todo/tool-todo/tsconfig.json
Extends `tsconfig.base.json`; references cordis/cosmokit/schemastery/core-tools/core-agent/core-session/session-projection.

#### packages/todo/tool-todo/locale/en.json
English UI catalogue: a single `meta.title` ("tool-todo").

#### packages/todo/tool-todo/locale/zh.json
Chinese catalogue with a `meta.description` about letting the AI create and update a task list.

#### packages/todo/tool-todo/README.md
Spec of `todo_write`: whole-list replacement, single-owner scope, the required `allowParallelInProgress` policy, and the standing-plan projection.

#### packages/todo/tool-todo/README.zh.md
Chinese translation of `tool-todo/README.md` (171 lines, same anchors).

#### packages/todo/tool-todo/README.i18n.yaml
Per-heading EN/ZH hashes for `tool-todo/README.md`.

---

## Ideas worth stealing

- **Reserve-then-admit continuation, validated on both sides of the downstream hook chain** — `packages/goal/goal-round-driver/src/index.ts:380` — the driver reserves `roundsStarted + 1` at idle, then the `agent/pre-step` listener re-verifies the *complete* claimed record (content, source, goal id, revision, phase, activation, next-round number) **before and after** `next()`. For August this is the missing half of the runaway guard: August bounds a turn, but has no mechanism that says "this continuation is *the* next admitted unit of work" and proves it was not overtaken between reservation and execution. The same file shows the failure vocabulary to copy — `round-limit`, `queue-failed`, `prompt-rejected` as stable blocker codes (`packages/goal/goal-round-driver/src/index.ts:182`).

- **Host-attested human authority for model-side state changes** — `packages/goal/tool-goal/src/authority.ts:80` — authority is proven by scanning the *open turn's* `user/message` events for `source.kind === 'user'`, a source the **host API** assigns, not the caller; and the check additionally requires the agent to be a runtime root, so a subagent can never create or edit a goal even with a human message in its turn. August's `remember`/`create_agent` doors need exactly this: a way to distinguish "the human asked" from "the scheduler asked" that a plugin cannot forge, plus a root-vs-subagent distinction. The hazard is documented in place at `packages/goal/tool-goal/src/authority.ts:78`: "`Agent.followup()` / `steer()`" default the source to `user`, so every non-human producer must supply its own.

- **Detect-and-retain instead of crash: a strict fold whose first failure disables host access but keeps the last valid client view** — `packages/goal/goal/src/index.ts:146` — `applyGoalProjection` catches the fold's throw and stores it in `state.failure`; the client keeps the last valid goal and `GoalService.state()` throws that failure. August's brain DB and transcript replay have the same shape of risk: a corrupt row should be *detected and pinned*, not crash the request. The decoder's own discipline (`packages/goal/goal/src/fold.ts:74`, exact key-set comparison, positive-integer checks, revision continuity, "the same blocking condition must persist for N rounds") is a directly reusable checklist.

- **Compare-and-set on every durable mutation, with the stale ref named in the error** — `packages/goal/goal/src/index.ts:456` — mutations take `{id, revision}` and a stale ref produces `GOAL_STALE_REVISION` quoting both the offered and the current revision. August's settings writes and brain facts would benefit from a single CAS discipline with an error a UI can render ("you were looking at revision 4, it is now 6").

- **Process-local authority that cannot survive a restart** — `packages/goal/goal/src/index.ts:248` and `:255` — the armed/disarmed flag lives in a `WeakMap<Session, …>` and is reset to `disarmed` on **every** `agent/created` edge, so a resumed or forked session never continues on its own; `disarm()` removes authority *without* writing a revision. August's "armed ceiling" semantics (the runaway backstop, the unattended-turn ceiling) are exactly this shape, and August currently expresses "absent = armed / 0 = off" — this repo expresses the same thing as a separate process-local channel that is *always* off at a session boundary.

- **A durable skill catalog whose identity is a digest over the published FACTS, not the rendered prose** — `packages/skill/tool-skill/src/index.ts:330` and `:233` — the catalog message records the exact entries it published (`SkillCatalogSource.entries`), and republication is decided by a SHA-256 over `JSON.stringify([name, description])` per entry joined by `\n` ("every separator is itself a legal description character, so only quoting makes the boundary exact"). August freezes its boot memory index per session to protect the provider prefix cache; this is the same discipline done properly, and it adds the piece August lacks — a **complete replacement** catalog (including an empty one that explicitly retires stale names) instead of a growing or stale list.

- **One canonical rendering for both load paths, so the model cannot tell who loaded a skill** — `packages/skill/skill/src/index.ts:170` and `packages/skill/tool-skill/src/index.ts:200` — `renderSkillContent` is shared verbatim by the `skill` tool result and the `/name` gesture injection, and the catalog's closing sentence tells the model not to load a skill the user already invoked. August's learned skills / `SKILL.md` layer would benefit from the same single-renderer rule plus the "user invoked it, do not call the tool again" anti-double-load sentence.

- **First-party mutation invalidation so the model sees its own write immediately** — `packages/skill/skill-filesystem/src/index.ts:142` — the provider listens for `fs/observed` with the actor's tool name and invalidates synchronously, while external changes go through the OS watcher. August installs skill files; if the catalogue only refreshes on a filesystem event, the agent's own `write_file` of a new skill would not be visible for the rest of the turn.

- **Token-budgeted, order-preserving tool-result retention with a reserved notice budget** — `packages/spill/spill-policy/src/retention.ts:48` and `packages/spill/spill-policy/src/index.ts:112` — instead of a character cap, the policy prices the actual content (route-aware image pricing included), reserves the **worst-case** omission notice *before* splitting the budget, keeps ordered head and tail, and treats images as indivisible. August's `maxToolResultChars` truncation is character-based and lossy in a different way; this gives a bounded *token* result whose notice is guaranteed to fit.

- **Exact omission accounting and surrogate-pair-safe slicing** — `packages/spill/spill-policy/src/retention.ts:95` and `:16` — `omittedBytes` is a subtraction (so "Omitted N bytes" is a fact, not an estimate) and `textSlice` refuses to cut between a UTF-16 surrogate pair. August truncates model output at char boundaries; the surrogate case is a real mojibake bug waiting to happen.

- **Injective path-segment encoding for a model-supplied filename** — `packages/spill/spill-local/src/store.ts:55` — every character outside `[A-Za-z0-9._-]` (and `~` itself) becomes `~XXXX`, the whole-segment `.` and `..` are escaped, and the file is created with `open(path, 'wx', 0o600)` so a pre-planted symlink cannot redirect the write. August writes tool output to disk using model-influenced names; this is the encoding to copy.

- **Model-visible data quoted as data** — `packages/goal/goal-round-driver/src/prompt.ts:16` — the objective is embedded with `JSON.stringify`, so an objective containing `</goal_round>` cannot close the framing tag; the control case is pinned at `packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts:175`. August injects user text into prompt blocks constantly; this is the two-line fix that keeps a user string from escaping its wrapper.

- **A model-visible grounding clause in the closing instruction** — `packages/goal/tool-goal/src/wrapup.ts:5` — "Report only what earlier rounds and tool results in this session actually establish; when a detail is not in the session, say so instead of inventing it." August's turn-end summaries and the wrap-up message after a long autonomous run would benefit from the same clause, delivered at the moment the model is about to write its final answer.

- **A capability policy expressed as one required deployment flag that changes both the enforcement and the wording** — `packages/todo/tool-todo/src/index.ts:29` and `:63` — `allowParallelInProgress` is required with no default, caps the number of `in_progress` items, *and* selects the sentence in the tool description; `packages/todo/tool-todo/tests/loader-composition.spec.ts:99` proves it end to end through the real Loader. August's per-model `toolSurface` / `maxTools` settings are the same idea but should also drive the description text, and should have a "no default" story.

- **Deferred work named as a workstream, not a TODO** — `packages/skill/skill-filesystem/src/index.ts:437` — the file carries an explicit `TODO(file-watch-service)` naming the seam to extract, and the README's Dev Note names the missing-root polling tradeoff as an open design question. August's AGENTS.md discipline about "Part N+1" applies to the same problem, but this repo's version is attached to the exact line.

---

## Files skipped (with reasons)

- `packages/skill/skill-office/tests/fixtures/encrypted.xlsx` — a **binary fixture**. I opened it: it is a 224-byte ZIP archive (`PK\x03\x04`) whose only entry is an 8-byte `[Content_Types].xml`, i.e. a minimal stub standing in for an encrypted workbook, not a real encrypted XLSX (a real one would be an OLE compound file). It is **not referenced by any test in the `skill-office` package** — a shard-scoped `grep` for `encrypted.xlsx` over `packages/` returned no matches — so it is a placeholder with no executable semantics. Not read line by line because it is binary and carries no readable logic.

Everything else in the shard (170 of 171 files) was opened and read.

---

## Uncertainties

- **Large test files were read by header + full test-name inventory + targeted body reads, not byte-for-byte.** For the six largest specs — `packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts` (1229 lines), `packages/goal/goal/tests/goal.spec.ts` (840), `packages/skill/skill/tests/skill.spec.ts` (~1270), `packages/skill/tool-skill/tests/tool-skill.spec.ts` (~1120), `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` (~860), `packages/spill/spill-policy/tests/spill-policy.spec.ts` (~620), `packages/spill/spill-local/tests/spill-local.spec.ts` (~580), `packages/skill/tool-workspace-dependencies/tests/tool-workspace-dependencies.spec.ts` (~480) — I read the import block, the full `describe`/`it` inventory, and contiguous body regions around the mechanisms I describe. I did **not** read every assertion line in those files. Their docblock headers are explicit about what they pin, so my per-file notes are accurate about *what is pinned*; I am less certain about individual assertion values in the ones I did not open in full.
- **The `packages/**/README.zh.md` files were sampled, not fully read** (I read the front-matter, the `## 概述` summary, and the `## 目录` TOC of each, and confirmed the line counts and anchor structure match the English originals). They are line-for-line Chinese translations of the English READMEs; I did not verify every translated sentence.
- **The `README.i18n.yaml` files were read as hash records, not as documentation.** They contain per-heading EN/ZH content hashes (e.g. `en: 47b9efbd26fb01af`) and the `verify-translation-pairing` command; the hashes themselves are not independently verifiable without the tool.
- **`locale/*.json` files were read in full** (they are 4–8 lines each: `meta.title` plus, in the Chinese files, a `meta.description`). Nothing about behaviour depends on them in this shard.
- **The `packages/skill/skill-office` e2e files** (`docx-validation.e2e.ts`, `render-tools.e2e.ts`, `visual-intent.e2e.ts`, `xlsx-validation.e2e.ts`) are **live-API** tests that are skipped without `DEEPSEEK_API_KEY` and `DSH_PRIMARY_RUNTIME`. I read their headers, configuration blocks and first case statements; I did not read their assertion bodies, so I can describe what they set up but not every assertion they make.
- **Not in this shard but adjacent:** the `agent/pre-step` contract, the `turnBoundary` projection, `Agent.followup()`/`steer()` source assignment, `ctx.tools` visibility scoping, and the `session-projection` registry are all consumed here but live in other packages. I referenced their documented contracts rather than verifying them in the code, so the exact semantics of `ctx.tools.get(name, agent) === tool` and of `turnBoundary.openTurnStartSeq` are taken from the consuming code and the READMEs, not from their own implementations.
- **The `skill-office` provider's `officeRuntime` path** depends on `import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json')`; I confirmed the code but did not verify that the resolved package layout (`lib/cli.js`) matches at runtime.
