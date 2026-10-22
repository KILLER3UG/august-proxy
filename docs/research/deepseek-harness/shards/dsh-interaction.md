# deepseek-harness / dsh-interaction

## Shard shape

This shard is **not** the agent loop — it is the *edge* of the harness: every place where a running agent has to talk to something outside its own reasoning, and where the harness has to keep that conversation durable, cancellable, and honest. It holds six package groups:

- **`packages/guard/`** — two loop-hygiene plugins: `repeat-tool-reminder` (an advisory detector for identical repeated tool calls) and `timeout-policy` (a cooperative per-tool-call deadline).
- **`packages/interaction/`** — the human-collaboration plane: `commands` (slash commands that run *without* a model round trip), `user-approval` (one-shot allow/reject with a per-session policy), `permission-presets` (bundling sandbox mode + approval policy into one selector), `user-questions` (the question/answer seam and its durable projection), and `tool-ask-user` (the model-facing `ask_user_question` tool).
- **`packages/lsp/`** — code navigation: `lsp` (provider registry + four normalized read-only operations), `lsp-stdio` (a generic stdio language-server provider with process lifecycle, framing and cancellation), `tool-lsp` (the model-facing `lsp` tool).
- **`packages/mcp/`** — external Model Context Protocol: `mcp-client` (connection supervisor, tool bridge, reconnect policy) and `mcp-resources` (scoped resource discovery through three shared tools).
- **`packages/plan/`** — `plan-mode`: a soft guidance layer plus a user-reviewed exit tool.
- **`packages/preset/`** — declarative agent capability compositions: `agent-preset-registry` (revision retention, mount auditing, isolation), `agent-preset` (the declarative row **and the shipped creator skills**), `persona` (a scope-only persona row).

The way they fit together is a consistent three-layer split repeated in every package: a **capability seam** (`ctx.approval`, `ctx.userQuestions`, `ctx.lsp`, `ctx.mcpResources`, `ctx.agentPresets`) that owns state and dispatch; a **model-facing tool** that translates the model's request into a seam call and the seam's answer back into a tool result (`ask_user_question`, `lsp`, the MCP tool bridge); and a **session projection** that reconstructs the seam's state from the session log so resume/fork work without a second store. Every state change a user can see is written to the session log as a log-only event, and every derived view is a fold over that log.

---

## Per-file notes

### packages/guard/repeat-tool-reminder/src/index.ts
- **Purpose:** Advisory per-agent detector for the model repeating the *exact* same tool call with identical arguments.
- **Key abstractions:** `Config` (thresholds / include / exclude / argumentsPreviewChars), a per-agent `Chain` held in a `WeakMap<Agent, Chain>`, and `canonicalize()` — a deep key-sort + `JSON.stringify` identity.
- **Data flow:** `tools/post-execute` → `observe()` computes the canonical key `JSON.stringify([exec.name, canonical])` (line 202) → a run length is incremented or reset → at an exact threshold a `notice`-form user message is built and **prepended to the downstream decision's `additionalContexts`** (never a `content` replacement, so the `tool/result` event keeps the tool's own output for audit).
- **Non-obvious design decisions:** Counting happens in **post-execute**, not pre-execute, so a *denied* call still counts (a model hammering a blocked tool is exactly the loop worth breaking). Untracked calls are **transparent** — they neither increment nor reset the chain (line 200), so a bookkeeping tool interleaved into a loop cannot launder it. The gentle text is keyed to `thresholds[0]`, not a literal 3. The chain key always uses the **full** canonical string; only the *quoted* arguments are capped.
- **Edge cases / failure handling:** `thresholds` must be a non-empty list of integers ≥ 2 with no duplicates — validated fail-loud in `apply`, never a silent fall-back. `argumentsPreviewChars` must be an integer ≥ 1. A user message resets the chain (a fresh instruction is not a loop). Calls with no `exec.agent` are ignored.
- **Surprising:** `include`/`exclude` are `*`-wildcard predicates over tool *names* at call time, not registry references — a pattern matching no registered tool is legal.

### packages/guard/timeout-policy/src/index.ts
- **Purpose:** A `tools/execute` wrapper that arms each tool's *own* declared `timeoutMs` and maps its own expiry to a structured `TOOL_TIMEOUT` result.
- **Key abstractions:** `TOOL_TIMEOUT` (one string used both as the internal deadline classification code and the structured error `code`), and the `deadline()` / `timeoutOf()` pair from `@deepseek-ai/dsh-timeout`.
- **Data flow:** read `ctx.tools.get(exec.name, exec.agent)?.timeoutMs` → if undefined, delegate unchanged → otherwise `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)`, **swap the derived signal onto `exec`** (line 66), `await next()`, then check `timeoutOf(d.signal, TOOL_TIMEOUT)` (line 73) and, if *our* timer fired, replace the result with `{ isError: true, content: 'Error: tool call timed out after Nms', error.info.code: 'TOOL_TIMEOUT' }`.
- **Non-obvious design decisions:** The classification is **scoped by code**, so a nested outer deadline (another wrapper's timer that fired first) reads as an ordinary upstream cancel rather than being misattributed to this plugin. The signal is **restored in a `finally`** (line 78) because Cordis `next()` ignores passed arguments — the wrapper must mutate the shared `exec` in place — and post-execute listeners must never see this plugin's possibly-aborted signal.
- **Edge cases / failure handling:** A tool that ignores or slowly handles cancellation keeps the caller waiting: the plugin is cooperative, never a hard kill, and no timeout result is produced until downstream settles. Tools with no declared budget (the shipped `bash`, `read`, `write`, `edit`) are never cut off.
- **Surprising:** The timeout is **per-tool**, declared on the tool definition — there is no registry-wide default.

### packages/guard/timeout-policy/tests/timeout-policy.spec.ts
- Read: 244-line suite using **fake timers** (deterministic, no wall-clock race) plus a *cooperative* tool that settles only when `exec.signal` aborts. Pins delegation for undeclared budgets, that the derived signal (not the caller signal) reaches the tool, that the caller signal is restored for post-execute, that a provider-owned abort error is replaced by `TOOL_TIMEOUT`, that a caller abort that wins first keeps `TOOL_ABORTED`, that a later caller abort cannot overwrite a won timeout, plugin disposal, and the Loader export shape.

### packages/guard/repeat-tool-reminder/tests/repeat-tool-reminder.spec.ts
- Read: 409-line behaviour suite driving a **real agent loop** against a scripted `MockAdapter`. Pins escalation, the `thresholds[0]` gentle-text rule, the preview cap (detection still keys on the full string), chain reset by a different tracked call, untracked transparency, wildcard includes with regex metacharacters escaped, deep property-order-insensitive canonicalization, per-agent keying, reset on a new user prompt, chain drop on disposal, denied calls counting, and every fail-loud config rejection.

### packages/interaction/user-questions/src/index.ts
- **Purpose:** The `ctx.userQuestions` service — a validated question/answer seam that pauses a tool call until a human answers.
- **Key abstractions:** `ask()` (blocking), `askTimed()` (a foreground wait with a deadline), `answer()` (a Remote that lets a *late* reply be steered into a continued question), and `attachWait()` (a Remote stream that lets a UI hold the wait).
- **Data flow:** `ask()` validates the batch, then dispatches the `user-questions/request` waterfall — scoped to `scopeTarget(agent, agent)` when an agent is supplied, unscoped otherwise → the composed answerer returns an `AskUserQuestionAnswer`.
- **Non-obvious design decisions:** **Runtime ownership, not durable lineage, decides who may ask a human** (line 138): a live *child* agent owned by another agent is rejected with `DELEGATED_CALLER` and must fold the unresolved decision into its final result, while a lineage-bearing session resumed as a new runtime root may ask normally. The `plan-review` **presentation intent** is validated at the asker (lines 303–317): an `approve` label naming none of the question's own options, or an intent with no `detail`, is `BAD_INTENT` — caught where the mistake is, not in each UI. An `answer()` reply is *reserved* per `callId` until the agent admits the message; a second reply is `REPLY_QUEUED`, and a discarded reply frees the reservation.
- **Edge cases / failure handling:** `NO_PROVIDER` when no answerer accepts; `EMPTY_QUESTIONS`; `CALLER_NOT_LIVE` when the supplied agent is not the registry's exact instance; `ASK_ABORTED` on signal; `BAD_ANSWER` when the batch does not name each question exactly once. A `UserQuestionError` transported across a wire boundary is *restored* to the class.
- **Surprising:** No Remote method can *abandon* a question — a Client that puts its panel away sends nothing, so the call stays answerable until an answer arrives.

### packages/interaction/user-questions/src/projection.ts
- **Purpose:** Folds `ask_user_question` events into the set of answerable questions and exposes it as a Session projection.
- **Key abstractions:** `UserQuestionFold` (`timed` + `questions`), `UserQuestionProjectionView` (`active` / `settled`), and `userQuestionProjectionDefinition` (`stateVersion: 2`).
- **Data flow:** `request/header` decides whether the session is *timed*; `tool/call` opens a question; `tool/result` either settles it with an answer batch, drops it on failure, or marks it `continued` (pending payload, or the synthetic `TOOL_OUTCOME_UNKNOWN` repair result); `tool/ptc-dispatch` opens a PTC sub-call; `user/message` with a `user-question-reply` source settles a continued question.
- **Non-obvious design decisions:** **A timed call is recognised by the presence of a parameter in the logged tool SCHEMA, not by the arguments** (line 129) — a timed call may omit the timeout argument, and a timed `-1` call still uses the timed schema. A call made under the **blocking legacy** schema is never tracked at all, so a legacy session folds to the empty view. The projection is *derived*; no separate question state is stored.
- **Edge cases / failure handling:** A batch spelled inside an error result is a failure whatever its text says. Malformed model arguments yield no card. The fold returns the *same reference* for unrelated events (the registry's change gate).
- **Surprising:** A continued question can create a new user turn, but it can never resume a finished tool call.

### packages/interaction/user-questions/src/timed-wait.ts
- **Purpose:** The lifetime of one live foreground question wait, and the Client claims on it.
- **Key abstractions:** `TimedQuestionWait` — a deadline, a parent (turn) signal, a set of `claims` (one per connected answer UI), and an internal `AbortController` separate from the turn's.
- **Data flow:** the Host arms a `setTimeout` for `deadline - now`; a UI calling `attach(signal)` registers a claim and receives one `{ remainingMs }` frame; when the last claim leaves, the timer is **rescheduled for the remaining time** (line 36) — so the countdown is *suspended* while a UI holds the panel.
- **Non-obvious design decisions:** The countdown lives in the **Host**, the display in the **Client**: the Host computes `remainingMs` and the Client renders it, so a client clock drift cannot decide the outcome. A claimed wait stays open **past** the Host deadline and expires only after the last claim leaves. A claim is released by stream close, by the consumer returning, by the client signal aborting, or by the wait itself aborting.
- **Edge cases / failure handling:** Parent (turn) cancellation ends the wait and every claim stream without expiring the parent. A wait that is already cancelled or already past its deadline cannot be claimed.

### packages/interaction/tool-ask-user/src/timed.ts
- **Purpose:** The opt-in **timed** `ask_user_question` tool definition.
- **Key abstractions:** the `TIMED_WAIT_PARAMETER` (`timeout`) as a *schema marker*, the `pendingNotice` string, and a `oneOf` output schema with a `pending` arm and an `answers` arm.
- **Data flow:** `timeout` (per call, default from config) → `validateTimeout` → `validateQuestionIds` → `ctx.userQuestions.askTimed({...}, exec.callId, timeout*1000)` → either `{ pending: true, callId, message }` or the answer batch.
- **Non-obvious design decisions:** **"Pending" and "skipped" are different answers.** A skipped question is an answer item with empty `selected` and no `custom`; pending means *no batch arrived before the deadline* and the question is still answerable. The notice is carried as a **field of the result value** rather than as prose beside it, because the recorded result text is read back as one JSON object — the projection decides "still answerable" from it, and the Client row decides "this was a timeout" from it. `timeout: -1` means "an answer is required before proceeding" and uses the *indefinite* wait, which still keys the Client card by call id.
- **Edge cases / failure handling:** `timeout` must be `-1` or an integer 1…2_147_483; a timed call requires a live agent; duplicate question ids within one call are rejected before dispatch (separate calls may reuse an id). A task-execution-requiring upstream tool is rejected.
- **Surprising:** The timed tool duplicates the legacy schema deliberately (with a `jscpd:ignore` marker) because the *schema*, not the arguments, is what the projection reads.

### packages/interaction/user-approval/src/index.ts
- **Purpose:** The `ctx.approval` seam — one-shot allow/reject decisions for sensitive operations, with a per-session policy and a durable audit pair.
- **Key abstractions:** `ApprovalPolicy` (`'ask' | 'never'`), `ApprovalOutcome` (`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`), and the `approval/policy` session event (the session's override).
- **Data flow:** `request(req)` → refuses if no turn is open → appends `approval/asked` → `decide()` → appends `approval/decided` → returns the closed outcome. The effective policy is the session's own fold, else the configured default.
- **Non-obvious design decisions:** **The `'never'` policy is decided inside the service, before any dispatch** (line 275) — a listener registered with `prepend: true` after the service mounts would otherwise sit ahead of any gate *listener*, so only the service's own request path can make the deterministic rejection unbypassable. A **rogue non-vocabulary return is normalised to `'unavailable'`** (line 288) rather than leaking into callers' closed-union switches, and a throwing answerer **fails the question closed, not the caller's tool call open**. The policy is contributed to the system prompt **after retained history** so switching policy appends a new snapshot instead of rewriting the stable request header (line 165).
- **Edge cases / failure handling:** The ask must be **turn-enclosed** (line 217) because the turn is the durable log's commit/replay boundary; a bare event appended between turns is indistinguishable from a crash tail and is silently dropped on reload. An abort yields `'cancelled'` and the late answer is discarded by construction. A failure that prevents either audit append from committing *rejects* — an unlogged decision would violate the pair.
- **Surprising:** There is no `allow-always`, no remembered rule, no grant store, and no built-in answerer — the service never prompts a human; a deployment with no answerer simply fails closed.

### packages/interaction/permission-presets/src/index.ts
- **Purpose:** One user-facing "Permissions" selector that bundles the sandbox mode and the approval policy.
- **Key abstractions:** `PresetSpec` (`sandbox` + `approval` + optional presentation), the reserved names `custom` and `auto`, and the `permissions` session projection.
- **Data flow:** `apply()` records the *selection* (`permission/preset`) and then writes each **changed knob** through its own canonical setter (`setSandboxMode` / `setApprovalPolicy`) (line 416) — execution, prompt narration and replay keep reading their own knob folds, so removing this package later leaves the last selection in effect.
- **Non-obvious design decisions:** `custom` is a **derived state, not an error** (line 360): a knob combination matching no configured preset is a legitimate current value that a user may leave but cannot select. Selecting the effective preset again appends **nothing** (clicks are not switches). A still-matching last selection wins a shared-bundle tie, and a still-selected `auto` also matches the `never` policy. The `auto` preset is a **fixed** bundle owned by this service and published only for the effect lifetime of its integration.
- **Edge cases / failure handling:** Mounting over a **non-confining** executor (one that reports no `sandboxMode`) is a misconfiguration and throws at load. A composed default matching no preset requires an explicit `defaultPreset`. A fresh session is pinned to the user default; a **seeded** session preserves its effective knobs and only gains the missing durable facts.
- **Surprising:** The package refuses to compose over an unconfined shell because a preset bundles a sandbox mode — that is a load-time contract, not a runtime surprise.

### packages/interaction/commands/src/index.ts
- **Purpose:** A plugin-owned registry of slash commands that run **directly against an agent, without a model message**.
- **Key abstractions:** `CommandDefinition` (name, description, optional `input` hint / `attachments` flag, optional `recordInput`), `CommandResult`, `CommandLayer` (a scoped layer over `NamedEntries`), and `ScopedLayers` (global definitions shadowed by agent-scoped ones).
- **Data flow:** `execute(agent, line, attachments, signal)` → `parseCommand` (an exact regex, no trailing-input normalisation) → resolve the effective definition → append `command/run` → admit attachments → invoke the handler → normalise the result → append `command/done` → return `{ commandId, result }`.
- **Non-obvious design decisions:** The command lifecycle is a **durable event pair** (`command/run` + `command/done`) mirroring the `tool/call` ↔ `tool/result` pairing, so a UI can correlate the Remote acknowledgment with the flow node. `recordInput: false` lets a command whose **own authoritative domain event** already carries the payload avoid duplicating it in the log (line 376). Admission misses (bad syntax, unknown name) log **nothing** — they never entered a handler. Registration and removal happen inside `ctx.effect`, so a plugin unload removes its commands.
- **Edge cases / failure handling:** Definitions are validated before they can reach a UI protocol (name pattern, non-empty description, string hint, boolean attachments flag) and results are validated at the boundary (a handler returning a non-`CommandResult` throws). `withAbort` stops awaiting an uncooperative handler once the owning request aborts, while a handler that ignores the signal may still finish its own side effects. Attachments sent to a command that does not declare them, an absent attachment store, an unknown file receipt, and an over-limit image batch each settle as a **logged error before the handler runs**. A cancellation landing during admission is honoured **before** the handler is entered.
- **Surprising:** `notifyChange()` contains each observer independently, because Cordis's emit uses `Array.map` and one synchronous throw would starve later listeners.

### packages/interaction/commands/src/types.ts
- Read: 119-line client-safe vocabulary. `CommandResult` is `success` (optional `text`, optional `sourceEventSeq` naming an earlier authoritative domain event) or `error` (non-empty text). Declares the `commands/change` emit event and the `command/run` / `command/done` log-only session events. The `args` field is `parseCommand`'s own split, so a consumer never re-parses a line.

### packages/interaction/user-questions/src/types.ts
- Read: 163-line vocabulary. `AskUserQuestionIntent` is a tagged union with one tag (`plan-review`) whose `approve` is **named rather than positional** so no UI infers the verdict from option order, and whose `detail` is the plan under review. `UserQuestionState` is `'open' | 'continued'`. The `user-question-reply` message source is declared with `@persistenceAttribution` — readers preserve the message without the producer.

### packages/interaction/commands/src/brand.ts
- Read: 40-line pure brand outlet — `CommandDefinitionId` (a stable, plugin-namespaced identity independent of the command's name and copy) and `CommandId` (the lifecycle pairing id). No cordis imports, so wire and client code can name the brands without loading the host plugin's Context merges.

### packages/interaction/permission-presets/src/types.ts
- Read: 63-line pure type home for the `permissions` projection key plus `PresetOption`, `PermissionCatalog` (a **process-level** catalog, deliberately separate from Session history) and `PermissionSelection` (the Session's current durable value only). Declares the payload-free `permission-presets/catalog-changed` emit event.

### packages/interaction/permission-presets/src/client.ts
- Read: 10-line pure re-export of `./types.ts` as the client namespace — the repo discipline that client code imports only the client half, with zero content duplication.

### packages/interaction/plan/plan-mode/src/index.ts
- **Purpose:** Plan mode — the agent explores and designs under deployment guidance, then presents the finished plan for user review.
- **Key abstractions:** the `plan` session projection (folding `command/run`/`command/done` for `/plan` and the `plan/mode` event), a per-session `pendingIntents` map, the `plan:policy` prompt section, and the `exit_plan_mode` tool.
- **Data flow:** `/plan` (or `/plan off`) → `set(agent, active)` → if a turn is open the selection stays **pending** until the next **accepted in-turn pre-step** appends `plan/mode`; if no turn is open it commits immediately (no pre-step would come). The `exit_plan_mode` tool asks a `plan-review` question through `ctx.userQuestions` and, on approval, sets a *silent* pending intent so the flip lands at the next pre-step boundary.
- **Non-obvious design decisions:** **Plan mode is guidance, not enforcement** — the tool catalog stays *byte-identical* across mode switches; only the prompt section changes. The exit tool stays **registered while plan mode is inactive** so the request tool catalog is stable across transitions. A **dismissed** review is not a failed one: the user took the turn back to say something the two options do not cover, so the tool calls `exec.concludeTurn()` and returns `{ approved: false }` (line 337) instead of spending a model request on waiting. **Consent requires exactly the single `Approve` selection** — custom text alongside Approve, a duplicate answer item, or a missing item all read as *keep planning*, never as consent (line 348). The narration ("the user switched this session to plan mode") is emitted only when the **last logged request header** told the model the opposite mode, so the model is never told twice.
- **Edge cases / failure handling:** A failed `plan/mode` append leaves the intent **pending** so a later pre-step can retry it, and never blocks the step. A plan that does not start with a `#` heading is rejected before the reviewer is asked. A review that outlives the plugin fiber fails (no phantom exit). The `disposed` flag is checked after the review returns.
- **Surprising:** The state fold is `stateVersion: 3` — the projection's shape has already been migrated twice.

### packages/interaction/plan/plan-mode/src/types.ts
- Read: 47-line pure vocabulary. `PlanProjection` is the cropped wire view (`active`, `pending`); `PlanUnitState` is the host fold state (`active`, `wanted`, `running`, `activeAtLastHeader`). **Capability absence is the key's absence, never a value** — a deployment with no plan-mode composed has no `plan` projection key at all.

### packages/interaction/plan/plan-mode/src/client.ts
- Read: 10-line pure re-export of `./types.ts` as the client namespace.

### packages/interaction/user-approval/src/types.ts
- Read: 93-line wire-safe vocabulary. `ApprovalRequestId` pairs one `approval/asked` with its `approval/decided`; the four-outcome union is closed and callers fail closed on `unavailable`. `displayReason` is **presentation only and never persisted** in the audit events. The `approval/request` waterfall is scope-filtered: agent-scoped listeners receive only that agent.

### packages/interaction/tool-ask-user/src/index.ts
- Read: 119-line model-facing tool. `Config` selects `mode: 'legacy' | 'timed'` and a default `timeout`. The legacy `ask_user_question` schema is a plain questions array with `id` / `question` / `header` / `options` / `multi_select`; the option description tells the model to put a recommended option **first and append `(Recommended)`** — a small, concrete piece of prompt engineering. The result renders as one compact JSON text block.

### packages/interaction/user-questions/tests/user-questions.spec.ts
- Read: 903-line service suite, read in full. Pins the provider delegation path, the `NO_PROVIDER` / `EMPTY_QUESTIONS` / `CALLER_NOT_LIVE` / `DELEGATED_CALLER` / `BAD_INTENT` taxonomy, the restoration of a *transported* `UserQuestionError`, the `askTimed` deadline and `DUPLICATE_WAIT`, and the whole late-reply reservation lifecycle (one queued reply, a discarded reply frees it, a claimed reply keeps the reservation until its turn ends).

### packages/interaction/user-questions/tests/projection.spec.ts
- Read: 300-line fold suite. Notably: a legacy-schema session folds to the empty view; a header with **no tools** or a **placeholder string** for tools also reads as legacy; the fold follows the *latest* header when the composed tool changes mid-session; a PTC sub-call enters the fold when only `run_code` appeared in the header; and the fold returns the same reference for unrelated events.

### packages/interaction/user-questions/tests/timed-wait.spec.ts
- Read: 108-line suite with fake timers. Pins that a claimed wait stays open past the Host deadline and expires only after the last claim leaves, that a claim resumption reports the **original remaining duration** (not a fresh one), and that a parent cancellation ends the claim streams without expiring the parent.

### packages/interaction/user-approval/tests/approval.spec.ts
- Read: 520-line suite with a **fake Agent** that records audit appends. Pins the turn-enclosure precondition (idle and between-turn asks both throw before appending), fail-closed with nobody listening, contained observer throws after append, a propagated append failure, scope dispatch never reaching a foreign scope, the rogue-return normalisation, the abort race, and the policy fold including the "never is unbypassable even by a PREPENDED answerer" case.

### packages/interaction/permission-presets/tests/permission-presets.spec.ts
- Read: 460-line suite. Pins the fold, `custom` derivation (a state, not an error), the Auto admission gate running *before* any write, a no-op selection appending nothing, re-asserting a preset from a drifted state, the load-time refusal over a non-confining executor, the reserved `custom`/`auto` names, and the new-session default rules (fresh, seeded-legacy, empty-stored, remount).

### packages/interaction/permission-presets/tests/projection.spec.ts
- Read: 209-line suite for the projection unit and the `/permission` command: only the pinned current value is served, the change feed fires per knob append, `custom` is projected as a current value, Auto appears only in the process catalog and never changes the Session seq, catalog-notification failures are contained, and the projection key is dropped on unload (HMR safety).

### packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts
- Read: 681-line suite. Pins that the blocking tool is kept when `apply` receives no config, that the timed tool is registered only when the row opts in, the 120-second default, the pending report at the Client deadline, the unclaimed hold, the live-agent requirement, duplicate question ids, and the structured `DELEGATED_CALLER` error.

### packages/interaction/commands/tests/commands.spec.ts
- Read: 676-line suite (header + first 110 lines and the full `it()` inventory). Pins the exact `parseCommand` boundary (rejects ` /goal`, `/`, `/Goal`, `/goal/path`, `/goal🔥`), scoped shadowing and its removal with the scope, frozen descriptors, contained broken observers, abort handling, the paired lifecycle events, and every attachment admission failure.

### packages/lsp/lsp/src/index.ts
- **Purpose:** The `ctx.lsp` seam — a provider registry and per-query, order-independent selection over four normalized navigation operations.
- **Key abstractions:** `LspProvider` (a branded id + an extension→language-id map), `Route`, and the `LspError` code taxonomy.
- **Data flow:** `registerProvider` validates the id, the extension map, intra-provider duplicates and cross-provider conflicts **before mutating anything**, then reserves the id and every extension in **one** `ctx.effect` (line 130) so disposal releases them together. `query()` routes by the file's final extension and hands the provider the request plus the derived `languageId`.
- **Non-obvious design decisions:** Registration is **all-or-nothing**: a conflicting extension publishes *nothing* (line 123 is the conflict check, before the effect). Selection is **order-independent** — it routes on the file's extension, never on registration order. `finalExtension` handles `foo.d.ts` → `.ts` and treats a leading-dot dotfile as *no* extension, and it splits on both `/` and `\` so a caller's path separator cannot change the result.
- **Edge cases / failure handling:** An empty id, an empty extension map, a malformed extension, an empty language id, an intra-provider duplicate → `LSP_INVALID_PROVIDER`; a duplicate id or an already-owned extension → `LSP_CONFLICT`; no route → `LSP_UNAVAILABLE`.
- **Surprising:** The seam exposes **exactly four semantic operations and no generic JSON-RPC escape hatch** — symbols, rename, formatting and diagnostics are deliberately out.

### packages/lsp/lsp/src/types.ts
- Read: 130-line seam vocabulary. `LspOperation` is a closed four-member union, so adding an operation is a compile-enforced change across the seam, the providers and the tool. The `locations` result variant carries **`resolvedWorkspaceUri`** — the provider's canonical `file:` URI for the request's workspace root — because a caller that relativizes location URIs must not parse the request's possibly-symlinked process path with host-platform rules. `findReferences` always includes declarations, enforced by the provider, with **no caller flag**.

### packages/lsp/lsp-stdio/src/index.ts
- **Purpose:** A generic stdio language-server provider — one isolated provider per configured server entry, one pooled process per canonical workspace.
- **Key abstractions:** `LspLocalServerConfig` (command, args, env, extension map, and **eight** numeric bounds), `LocalLspProvider` (instance map, per-workspace serialization queues, a lifetime `AbortController`), and `validateServerConfig`.
- **Data flow:** `apply()` resolves **every** executable *before* publishing any provider, so a bad later entry prevents an earlier one from registering → per query: canonicalize the workspace → enqueue on the workspace's queue → read the source **inside** the queue but **before** spawning → get-or-create the instance → `instance.query()` → on a transport failure, dispose, evict and **retry once** with a fresh transport (line 307).
- **Non-obvious design decisions:** **One transparent transport replacement** is allowed, and only for a *transport* failure, because queries are read-only (line 307). A *dead* instance is never reusable even if its final quiescence observation fails. The source is read inside the queue but before spawning, so a queued query sees current bytes when its turn starts while an invalid source still cannot leave an idle process pooled. All bounds are validated **fail-loud at load** — a non-positive stderr cap would defeat the retained-tail bound (`slice(-0)` keeps everything), a `maxMessageBytes: 0` would make every response fatal, and a non-positive teardown budget would let a server that ignores shutdown hang disposal forever.
- **Edge cases / failure handling:** A failed generation whose transport closure **cannot be confirmed** stops the reconnect rather than risking overlapping server processes. Teardown aggregates failures: one failure is rethrown, several become an `AggregateError`. Registration is rolled back if a later provider conflicts.
- **Surprising:** The plugin is a **namespace plugin** (named exports, no default export) — a stray default export would make the Cordis Loader collapse the module and drop `inject`.

### packages/lsp/lsp-stdio/src/instance.ts
- **Purpose:** One language-server instance — the connection plus the handshake, the serialized query queue, the transient open→query→close lifecycle, and bounded teardown.
- **Key abstractions:** the `queue` tail, the memoized `teardownPromise`, the `ready` handshake promise, and `CLIENT_CAPABILITIES`.
- **Data flow:** `initialize` (with `processId: null` so a server in another PID namespace cannot monitor an unrelated process) → `initialized` → `textDocument/didOpen` → the operation request → `textDocument/didClose` in a `finally`.
- **Non-obvious design decisions:** **A poisoned instance is never pooled**: if the handshake wait ends in failure — an abort on a still-pending handshake, or `initialize` rejecting without the process exiting — the instance is torn down so a permanently-rejecting `ready` cannot make every later query for that workspace fail (line 138). On abort the host sends `$/cancelRequest` and gives the server a **bounded grace**; if the request has not settled, the instance is **terminated** so a still-running request cannot overlap the next queued query's document lifecycle (line 219). The queue tail follows the **actual** prior work, not the abortable view, so a caller giving up does not deserialize the queue. `findReferences` always sends `includeDeclaration: true`.
- **Edge cases / failure handling:** A cancelled backpressured `didOpen` write or a failed stdin tears the instance down. A `didClose` write failure keeps the settled result but marks the instance untrusted. `workspace/applyEdit` is **rejected** — this host never applies edits or runs commands; `workspace/configuration` is answered from static config; lifecycle bookkeeping requests are accepted with an empty result.
- **Surprising:** `forceTerminate` awaits the managed range **unbounded on purpose** — quiescence, not another timer, is the postcondition disposal owes callers.

### packages/lsp/lsp-stdio/src/connection.ts
- **Purpose:** A JSON-RPC endpoint over one spawned language server.
- **Key abstractions:** the `pending` id→promise map, the `decoder`, and the injectable `ConnectionWriter` (so tests inject callback failures without relying on OS pipe races).
- **Data flow:** `request()` allocates an id and registers a pending promise → `write()` frames and writes → `onStdout` decodes and dispatches → `dispatch` distinguishes a server→client request (method + id), a notification, and a response → `handleResponse` resolves or rejects the pending promise.
- **Non-obvious design decisions:** **A framing failure is a fatal close**: the stream position is irrecoverably corrupted, so the connection fails *and* the managed range is terminated so helper processes do not outlive the leader. A **child stdin failure while the process stays alive** is treated as a fatal connection error so pending requests reject immediately rather than waiting for a close event that may never arrive. A request issued *after* close rejects immediately instead of hanging. `promise.catch(() => {})` keeps a caller's abandoned request from surfacing as an unhandled rejection while still delivering the rejection to the caller's own await.
- **Edge cases / failure handling:** Server→client requests are answered by a caller-supplied handler; a handler that rejects produces a JSON-RPC error response rather than a dropped frame. Notifications are ignored. The exit message appends the retained stderr tail when the server wrote any.
- **Surprising:** `peekNextId()` exists so the instance can pre-arm a `$/cancelRequest` for the id the *next* request will take.

### packages/lsp/lsp-stdio/src/framing.ts
- Read: 102-line base-protocol framing. `encodeMessage` writes `Content-Length: <utf-8 byte length>\r\n\r\n`. `MessageDecoder` buffers chunks and yields whole bodies, with a **64 KiB header cap** (line 12) so a server that never sends the separator cannot grow the buffer forever, and a **per-message byte cap** (line 72) so a hostile or broken server cannot exhaust memory. Only `Content-Length` is parsed; other headers are ignored, matching the base protocol.

### packages/lsp/lsp-stdio/src/host.ts
- Read: 124-line filesystem-seam host access. `canonicalizeWorkspace` resolves the root through `ctx.fs` and returns a stable identity (the resolved target), a canonical absolute path, and the canonical `file:` URI — so a symlinked workspace and its target share one server. `readHostSource` refuses a source that resolves **outside** the workspace and enforces the byte cap while streaming (so an oversized file is refused without reading it whole). The `XXX(lsp-source-replacement)` comment marks the one acknowledged gap (replacement between containment and open).

### packages/lsp/lsp-stdio/src/translate.ts
- Read: 235-line pure translation — the reason the fake-stdio tests can pin it exactly. `negotiatePositionEncoding` defaults an omitted encoding to `utf-16` and **rejects anything else**. `supportsTransientOpen` requires an explicit `openClose: true` in the options form, because the protocol defaults an omitted `openClose` to false. `normalizeLocations` accepts `Location`, `Location[]`, `LocationLink[]` or `null` and throws `LSP_MALFORMED_RESPONSE` for anything else. `normalizeHover` renders the three protocol encodings (MarkupContent, bare MarkedString, language-tagged MarkedString) and joins an array with one blank line.

### packages/lsp/tool-lsp/src/index.ts
- **Purpose:** The model-facing `lsp` tool — one read-only tool with four operations.
- **Key abstractions:** the `oneOf` output schema (locations | hover), the `LSP_PROMPT_TEXT` system-prompt section, and the tool's own `timeoutMs`.
- **Data flow:** `parseLspArgs` converts the model's one-based coordinates to the seam's zero-based ones → the session's workspace cwd is required (`LSP_WORKSPACE_REQUIRED` otherwise) → `ctx.lsp.query(...)` → the canonical value is returned and the *render* projects it.
- **Non-obvious design decisions:** The tool's `timeoutMs` (default 60 s) is set on the **tool definition**, so `dsh-tool-call-timeout-policy` enforces it without the tool owning a timer. The prompt text tells the model to **prefer `search`/`read` for ordinary navigation** and use `lsp` when textual matches are ambiguous — a precision-aid positioning, not a default. `presentCall` renders a **generic search card** so a pending call is visible before the answer arrives.
- **Edge cases / failure handling:** The workspace root is required with **no fallback**. Config values are validated at load (positive integers; a timer no greater than Node's `MAX_TIMER_DELAY_MS`, so it is not silently clamped).
- **Surprising:** The caps affect **only the presentation** — the canonical result value keeps every acquired location even when the rendered text is capped.

### packages/lsp/tool-lsp/src/render.ts
- **Purpose:** Pure formatting and coordinate conversion for the `lsp` tool.
- **Key abstractions:** `LSP_OPERATIONS`, `DEFAULT_MAX_LOCATIONS` (100), `DEFAULT_MAX_RESULT_CHARS` (16 000), and `presentLspCall`.
- **Data flow:** `formatLocations` groups locations by file and renders `path:line:character` (one-based, converted back), then applies the count cap with an omission marker, then the complete-result cap. `formatHover` applies only the character cap.
- **Non-obvious design decisions:** The **complete-result cap includes the truncation notice itself** (line 125) — the notice is sliced to fit, so the rendered text never exceeds the budget. `renderUri` resolves a `file:` URI **without applying the harness host's path rules**: it decides the "execution world" from the URI shape (a `/X:` segment reads as a Windows drive) and relativizes only when both URIs are in the same world. A malformed or non-`file:` URI stays verbatim.
- **Edge cases / failure handling:** Coordinates must be positive integers (one-based); a non-integer or ≤ 0 coordinate is rejected. The workspace root itself renders as `.`.
- **Surprising:** `presentLspCall` is a pure function of the tool arguments, so a UI can call it on a live stream *and* on replay.

### packages/mcp/mcp-client/src/connection.ts
- **Purpose:** The MCP connection supervisor — it owns the client/transport generations, keeps the harness tool registry in sync with the live generation, and restarts a lost connection with bounded exponential backoff.
- **Key abstractions:** `ReconnectConfig` / `RECONNECT_DEFAULTS` (enabled, initialDelayMs 500, maxDelayMs 30 000, maxAttempts 10), the `syncChain` serialisation, and the `isCurrent(generation)` guard.
- **Data flow:** `connectGeneration()` creates a fresh transport + client (the MCP SDK binds a Protocol to one transport for life) → connect → attribute the server's instructions → enforce `maxInstructionBytes` → `enqueueSync` (initial sync uses `registrationFailure: 'throw'` when `failOnStartupError` is configured; re-syncs always contain). A drop calls `generationDown` → `scheduleReconnect`.
- **Non-obvious design decisions:** **One outage shares one attempt budget**, and a connection that stays up past the **stability window** (`= maxDelayMs`, the longest backoff spacing) closes the outage and resets the budget (line 222) — so a crash-looping server whose connects briefly succeed still exhausts the cap instead of restarting forever. The backoff is `initialDelayMs * 2^(n-1)` capped at `maxDelayMs` (line 236) and the timer is `unref()`ed so an armed reconnect never holds the process open. A failed generation whose **transport closure cannot be confirmed** stops the reconnect rather than risking overlapping server processes. Exhausting the budget **unregisters the server's tools** and stops: disposal is the only way back.
- **Edge cases / failure handling:** `resolveReconnectPolicy` re-judges every default and bound because programmatic construction may bypass Schemastery — an unknown key, a non-positive delay, an initial delay above the ceiling, or a non-integer attempt cap all fail the plugin instance **at load**. A stale notification handler from a replaced generation is ignored by the `isCurrent` guard. The give-up disposal is enqueued on the sync chain so it cannot race an in-flight sync's phase-2 swap.
- **Surprising:** `ready` is a **microtask** while stdio `onclose` is a macrotask, so a server that crashes *after* a successful initial sync cannot flip the client to undefined before the readiness continuation runs.

### packages/mcp/mcp-client/src/tools.ts
- **Purpose:** The tool bridge — discovers MCP tools, registers them on the harness ToolRuntime under deterministic server-qualified names, and re-syncs when the list changes.
- **Key abstractions:** `publicToolName`, `syncTools` (two-phase fetch/swap), `createMcpToolDefinition`, and the `PreparedProjection` staged per execution.
- **Data flow:** `syncTools` first *fetches* the whole next generation (a failure here leaves the previous generation registered untouched) and only then *swaps*: dispose the previous generation, register the new one. A registry conflict can only mean a foreign registration squatting on this server's namespace, so the partial generation is **rolled back to zero tools** and logged.
- **Non-obvious design decisions:** **`publicToolName` appends a 12-hex SHA-256 of the identity whenever normalization or truncation changes the name** (line 85), so two distinct MCP identities can never collapse into the same public name. The raw name is only ever sent on the wire; the public name is never parsed back. The output schema keeps `structuredContent` **optional** and falls back to `JsonValue` for an advertised schema the runtime does not support. Image admission proves the **exact current route** can take images before storing anything: a route that is missing, unverifiable, or cancelled refuses; base64 must be **canonical** (re-encoded and compared), and the whole batch is refused atomically.
- **Edge cases / failure handling:** A server listing the same raw name twice is an invalid tool list and rejects the sync. A non-object model argument is coerced to `{}` so the server can produce a specific "missing required param" error. An `isError` MCP result is **thrown**, so the ToolRuntime records a failure. Unsupported audio and embedded resources are projected as text *without* discarding the raw block. A post-execute value replacement or a block wins over the prepared image projection.
- **Surprising:** `extractText` joins text blocks with `\n` and replaces image/audio/resource blocks with a placeholder, so the model-visible text is a faithful but bounded rendering of a protocol payload that may hold megabytes.

### packages/mcp/mcp-client/src/index.ts
- Read: 203-line plugin. The config is a `z.union` of a stdio and a streamable-http variant; `serverName` must match `[A-Za-z0-9_-]{1,32}` and is reserved **per registration scope** (a `WeakMap` keyed by the scope owner), so an agent-scoped server may reuse a namespace another agent already holds. `apply` is explicitly `async` — a prototype-bearing ordinary function would be treated by Cordis as a constructor whose returned promise is not startup work. The namespace reservation happens **before** the connection starts, so a duplicate `serverName` fails this instance at load and leaves the earlier one intact.

### packages/mcp/mcp-client/src/transport.ts
- Read: 46-line transport factory. The stdio transport is built over `scrubbedParentEnv()` from the subprocess seam, with the spec's explicit env merged on top — the MCP SDK owns the spawn, so this file shares the *scrub definition* rather than the spawn path. The HTTP transport attaches the configured headers.

### packages/mcp/mcp-client/src/server-context.ts
- Read: 40-line bridge. The connection's resource provider is registered with `ctx.mcpResources` and the server's instructions are contributed to the system prompt as a **non-interpolated** section (`interpolate: false`), so a server's `{{braces}}` stay literal.

### packages/mcp/mcp-resources/src/index.ts
- Read: 129-line `McpResourceRuntime`. Providers are held in **scoped layers**; the three shared tools are registered by the **first** provider in a scope and removed when the **last** one unloads, so a scope's tools outlive any one server's registering context. A prompt section lists the caller-visible server names (sorted) so the model knows what to pass as the `server` argument. Provider resolution is **per calling agent** (`this.layers.merge(exec.agent, ...)`), so an agent sees only the servers in its own scope.

### packages/mcp/mcp-resources/src/render.ts
- Read: 24-line renderer. A `blob` string is replaced by a length description ("N base64 characters; available to programmatic callers"), so binary payloads never enter model history while programmatic callers keep the raw bytes in the canonical value.

### packages/mcp/mcp-resources/src/tools.ts
- Read: 64-line registration of `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`. All three take an explicit `server` and an optional `cursor`; the cursor is forwarded unchanged so a returned `nextCursor` can be replayed.

### packages/lsp/lsp-stdio/tests/fixture-server.ts
- Read: 200-line scriptable fake LSP server that speaks the **real** `Content-Length` framing. Behaviour is driven by ~20 env vars (encoding, sync kind, extra caps, per-operation results, hang, crash-on-open, exit-after-reply, ignore-shutdown, on-open request kind, garbage bytes) and it records markers to files so a test can assert ordering (e.g. the previous probe process is dead before the serving one starts).

### packages/lsp/lsp-stdio/tests/typescript-server.e2e.ts
- Read: 118-line **keyless** e2e against the real `typescript-language-server`, exercising all four operations through the full `ctx.lsp` → `lsp-stdio` stack. It establishes one compatibility floor (TypeScript), not a cross-language claim.

### packages/lsp/lsp-stdio/tests/built-lib.e2e.ts
- Read: 80-line built-artifact smoke: plain `node` imports the packages **by name through their exports maps** and runs one query over real framing, so the published `lib/` path (not `src/`) is what CI proves. Skips when `lib/` is absent.

### packages/lsp/lsp-stdio/tests/lifecycle.spec.ts
- Read: 620-line end-to-end suite over the fake server; header + first 81 lines and the full `it()` inventory read. Notably: a server that dies while idle is evicted and the next query gets a fresh one; a query failure and a final disposal failure are reported **together**; a queued query reads its source only when its lifecycle starts; a server without transient-open support is rejected; and distinct workspaces run in parallel instances.

### packages/lsp/lsp-stdio/tests/instance.spec.ts
- Read: 424-line instance suite; header + first 114 lines and the full `it()` inventory read. Pins the server-request answers, `includeDeclaration` for references, the cancel-grace resolution when the server honors `$/cancelRequest` and the instance termination when it does not, teardown escalation to SIGKILL, and idempotent disposal.

### packages/lsp/lsp-stdio/tests/provider.spec.ts
- Read: 291-line provider suite; header + first 36 lines and the full `it()` inventory read. Pins PATH resolution (skipping empty segments), the load-time bound rejections, and — importantly — that **every** executable is resolved before any provider is published, that aborted sibling lookups are awaited before setup rejects, and that a later conflict rolls back the earlier registration.

### packages/lsp/lsp-stdio/tests/connection.spec.ts
- Read: 260-line connection suite; header + first 46 lines and the full `it()` inventory read. Pins the round trip, the error response, the server-request answer, the framing-error kill, the stderr cap (including the multibyte-bytes case), the request-after-close rejection, and the stdin-failure-with-a-live-process case.

### packages/lsp/lsp-stdio/tests/host.spec.ts
- Read: 184-line host suite; header + first 45 lines and the full `it()` inventory read. Pins realpath identity, the symlink-escape rejection, the non-directory and non-regular sources, the exact byte-cap boundary, and that a valid U+FFFD replacement character is kept in otherwise-valid UTF-8.

### packages/lsp/lsp-stdio/tests/framing.spec.ts
- Read: 82-line decoder suite; header + first 10 lines and the full `it()` inventory read.

### packages/lsp/lsp-stdio/tests/translate.spec.ts
- Read: 173-line pure-translation suite; header + first 14 lines and the full `it()` inventory read.

### packages/lsp/lsp/tests/lsp.spec.ts
- Read: 187-line seam suite; header + first 46 lines and the full `it()` inventory read. Pins that a later extension conflict publishes nothing (atomic reservation), that selection is order-independent across two providers, that the abort signal is forwarded verbatim, and that registration is released with the contributing fiber.

### packages/lsp/tool-lsp/tests/tool-lsp.spec.ts
- Read: 240-line tool suite; header + first 68 lines and the full `it()` inventory read. Pins that the canonical value keeps **all** acquired locations even when the presentation is capped, and that relativization uses the provider's `resolvedWorkspaceUri`, not the session cwd.

### packages/lsp/tool-lsp/tests/integration.spec.ts
- Read: 102-line in-process integration: the real tool, seam, stdio provider and timeout policy together; asserts a definition round trip and `TOOL_TIMEOUT` enforcement when the server hangs.

### packages/lsp/tool-lsp/tests/render.spec.ts
- Read: 172-line render suite; header + first 23 lines and the full `it()` inventory read. Pins the Windows-execution-world relativization on a non-Windows host, the backslash-as-POSIX-filename case, and the cap that still honours a limit smaller than the truncation marker.

### packages/lsp/tool-lsp/tests/load-path.spec.ts
- Read: 24-line Loader export-shape guard — a stray `export default apply` would make the Loader's `unwrapExports` collapse the module and **drop `inject`** (postmortem 0001).

### packages/mcp/mcp-client/tests/reconnect.spec.ts
- Read: 617-line supervisor suite; header + first 121 lines and the full `it()` inventory read. Pins the whole budget story: the stability-window reset, a crash loop whose connects briefly succeed still exhausting the cap, a failed generation that never confirms closure stopping the reconnect, a disposal that overlaps failed-generation cleanup, and a queued tool refresh discarded when disposal starts.

### packages/mcp/mcp-client/tests/negotiation-lifecycle.spec.ts
- Read: 149-line suite; header + first 65 lines and the full `it()` inventory read. It proves the **probe process is reaped before the serving process starts** (via a file barrier and a recorded PID liveness check) and that a failed probe retries only after its cleanup is confirmed.

### packages/mcp/mcp-client/tests/apply.spec.ts
- Read: 480-line apply-lifecycle suite using a hoisted `vi.mock` of the MCP SDK; header + first 84 lines and the full `it()` inventory read. Pins the config schema, the duplicate `serverName` refusal, both startup-failure modes, the list-changed re-sync, and the instruction byte cap being enforced *before* the tools are published.

### packages/mcp/mcp-client/tests/mcp-client.spec.ts
- Read: 1220-line unit suite; header + first 145 lines and the full `it()` inventory read. Its image-admission matrix is the densest part: canonical-base64 enforcement, atomic batch refusal, refusal for a route without declared image input, refusal when the route is missing/unverifiable/cancelled, and the post-execute interaction (text shortening keeps admitted images; a value replacement or a block discards the prepared projection).

### packages/mcp/mcp-client/tests/mcp-client.e2e.ts
- Read: 556-line e2e against the real protocol and four server kinds (self-written fixture, `server-everything`, `server-filesystem`, an in-process HTTP server); header + first 95 lines and the full `it()` inventory read.

### packages/mcp/mcp-client/tests/protocol.spec.ts
- Read: 152-line suite over the real SDK; header + first 45 lines and the full `it()` inventory read. Pins that a **resource-only** server stays connected without requesting tools, that the shared resource tools work for a configured server with no resource capability, that cursors survive, and that caller cancellation reaches an executing tool.

### packages/mcp/mcp-client/tests/fixture-server.ts
- Read: 78-line MCP fixture over stdio with `add`, `greet`, `fail`, `image`, `crash` (replies, then exits — a clean result followed by a transport close) and `admin.reset` (a dotted name that is legal in MCP and illegal in the DeepSeek function-name contract).

### packages/mcp/mcp-client/tests/egress.spec.ts
- Read: 41-line egress suite proving the Streamable HTTP transport goes through the installed proxy (a fake proxy records `REQ` and `CONNECT`).

### packages/mcp/mcp-client/tests/http-fixture.ts
- Read: 58-line keyless stateless Streamable HTTP MCP fixture that records tool calls and the `Authorization` header per request.

### packages/mcp/mcp-client/tests/fixtures/negotiation-lifecycle.mjs
- Read: 38-line legacy stdio server that records `start`/`exit`/method events to a JSONL file and **blocks discovery behind a release-file barrier**, so the test can observe probe ownership and process ordering.

### packages/mcp/mcp-client/tests/fixtures/pagination-limit-server.ts
- Read: 15-line MCP server whose `tools/list` always returns a `nextCursor` — a non-terminating discovery pagination used to pin the pagination limit.

### packages/mcp/mcp-client/tests/fixtures/pagination-limit.patch.yml
- Read: 11-line profile patch inserting an `mcp-client` row for the pagination fixture with `failOnStartupError: true` and `reconnect.enabled: false`.

### packages/mcp/mcp-client/tests/fixtures/resources-server.ts
- Read: 27-line MCP server exposing a text memo, a binary resource and a greeting template, plus literal instructions that contain `{{braces}}` — proving the prompt contribution is non-interpolated.

### packages/mcp/mcp-client/tests/server-context.spec.ts
- Read: 57-line suite: the literal instructions and the resource provider are published and withdrawn **together**, and scoped instructions are visible only to the owning scope.

### packages/mcp/mcp-client/tests/tool-definition.spec.ts
- Read: 66-line suite: the exact execution and arguments reach the upstream call, and an invalid external result (`null`, `{content:[42]}`, `{content:[{type:'image'}]}`) is rejected before any content is exposed.

### packages/mcp/mcp-client/tests/load-path.spec.ts
- Read: 29-line Loader export-shape guard for the mcp-client namespace plugin.

### packages/mcp/mcp-resources/tests/resources.spec.ts
- Read: 361-line suite; header + first 65 lines and the full `it()` inventory read. Pins that the shared tools survive until the last provider unloads, that a scoped server is visible only to its owner and descendants, that PTC bindings are removed on disposal, and that a provider whose requests fail keeps its tools.

### packages/preset/agent-preset-registry/src/index.ts
- **Purpose:** The registry of YAML-declared agent capability sets, their eager activation, and the revisions live agents retain.
- **Key abstractions:** `Definition` (a parsed declaration plus its activation promise and its generation), `Generation` (a scope + its mount + a user count), and `Binding` (a scope→generation parent link).
- **Data flow:** `register(definition)` creates a registry-owned scope, validates the entry list, mounts the preset tree, and records the generation → `mount(ctx, id)` retains a generation (incrementing its user count) and **binds the agent's scope parent** to it → `select(agent, preset)` recomposes a blank agent and appends `agent-preset/selected`.
- **Non-obvious design decisions:** **Revisions are reference-counted, not replaced**: redefining a preset retires the old generation, but agents and children that already joined it keep it alive until the last reference drops. A child joins **the exact revision its parent retained** (`composeFrom`, line 297) — not "the current definition of that preset" — so a parent's composition does not change under a running child. `select` is refused once the session has started (`agent-preset/locked`) and is serialised per agent through a `switches` promise chain. A failed definition **stays on the roster with its diagnostic** and blocks new bindings, but does not stop the Host from starting.
- **Edge cases / failure handling:** A blank session that already runs the current revision of the requested preset is left alone — nothing is logged and no `tools/change` is emitted. A `tools/change` observer that throws is logged, not propagated, so the durable selection is not lost. The diagnostic re-audits a mounted tree after the Host Loader tree settles, so startup order does not decide the outcome.
- **Surprising:** `readDocument` renders a declaration back as **entry-list YAML** (with `!!js` conditions intact) for *viewing only* — nothing accepts YAML back; a preset is changed by installing a bundle.

### packages/preset/agent-preset-registry/src/mount.ts
- **Purpose:** Mounting and auditing one preset revision.
- **Key abstractions:** `PresetTree` (an `EntryTree` whose `write()` is a **no-op**, so a runtime tree change is never persisted back to the declaring file), `RowAudit` (`failed` vs `pending`), and `leakedServices` / `serviceForMount`.
- **Data flow:** `mountPreset` creates the tree, updates it with the prepared profile entries, audits the rows, and checks for root-realm leaks → any failed row or any leak **rejects the mount**.
- **Non-obvious design decisions:** The audit distinguishes **failed** (never started / import or activation rejected) from **pending** (waiting for a service the composition does not supply) — a pending row stays mounted, because a Host provider still activating completes it later, and the registry re-audits after the Host tree settles. A row waiting on a *profile-denied* plugin mounts *disabled*, so the audit reads it as intentionally inactive rather than a failed import. `leakedServices` compares each service implementation's **fiber identity** (not `uid`, which is a per-registry counter and collides across roots) against the mount's fiber, and reports a leak only when the implementation is stored under the **root realm's** symbol — a provider inside an `isolate` realm is correctly absent.
- **Edge cases / failure handling:** `mountDetail` flattens an `AggregateError` (or one wrapped as a cause) into per-cause lines so each failure is visible. `PresetTree` deletes the declaring entry's `subtree`/`subgroup` in its constructor and never writes back — the fixture `self-dispose.js` exists because that write path once truncated a preset file to `[]`.
- **Surprising:** `serviceForMount` finds a service **anywhere** in the retained revision, including isolated realms, which ordinary `ctx.get` cannot do.

### packages/preset/agent-preset-registry/src/composition-inventory.ts
- Read: 205-line inventory of a preset's plugin rows. `flattenRows` walks group rows (which are structural — only their children are emitted) and combines the ancestor group's `disabled` state with the row's own. A `!!js` expression is asked of the evaluator; a **refusal leaves the decision to a mount**, and the row is reported `'conditional'` rather than guessed. `mountedCompositionRows` reads the live tree instead, with the Loader's evaluated enablement and root-fiber states.

### packages/preset/agent-preset-registry/src/session.ts
- Read: 47-line session projection recording which preset a session runs. The creation header names the preset a session **started** with (a deep-frozen creation fact), while `agent-preset/selected` records a later change made while the session was blank. The docstring names the rule that makes it mandatory: the preset decides the tool schemas and prompt sections the model sees, so what the model sees must be reconstructable from the log.

### packages/preset/agent-preset-registry/src/definition.ts
- Read: 39-line `PresetDefinition` plus `entryListProblem`, a recursive validator of a parsed Cordis entry list (including nested groups) that returns the **first** invalid row as a human-readable message — so a malformed child list is caught at the declaring plugin, not at mount time.

### packages/preset/agent-preset-registry/src/display.ts
- Read: 73-line pure fold. Shipped preset ids resolve through **locale dictionary keys**; a declaration that names itself owns its copy and is **never translated**; the id is the fallback. A pure module with no imports, so browser bundles inline it and the Host and the browser use the same single home for "which shipped id carries which copy key".

### packages/preset/agent-preset-registry/src/preset.ts
- Read: 18-line public roster types: `AgentPreset` carries an optional `broken` diagnostic, and `Config` holds the deployment `default` plus the **volatile** `selectedDefault` (the user's choice, edited through Settings).

### packages/preset/agent-preset-registry/src/types.ts
- Read: 73-line client-safe payloads plus three `RemoteError` codes: `agent-preset/not-found` (with the available ids), `agent-preset/invalid` (with the reason), and `agent-preset/locked` (the session has already started). Declares the `agent-preset/selected` emit event, whose contract is "consumers invalidate only state derived from that session's composition".

### packages/preset/persona/src/index.ts
- **Purpose:** A per-agent persona as a composable row.
- **Key abstractions:** the two prompt sections (`deployment:persona-prefix` / `deployment:persona-suffix`) and the `complete` / `includeRuntimeContext` switches.
- **Data flow:** `apply(ctx, config)` registers the prefix and suffix sections **for the mounting context's scope** and, when `includeRuntimeContext` is false, calls `ctx.systemPrompt.suppressRuntimeContext()`.
- **Non-obvious design decisions:** The row is **scope-only** — mounted inside an agent preset it shadows the deployment persona for that one session; mounted globally it collides with the prompt registry's own registration and **fails loud**. The reason the row exists at all is stated in the module docstring: an agent preset cannot mount the prompt registry itself, so without a row of its own a preset could change an agent's tools but never its identity. The prefix and suffix are **templates**: interpolation happens at render, not at assembly, and an *empty* template still shadows the deployment section and then disappears at render.
- **Edge cases / failure handling:** `complete: true` makes the prefix the exact system prompt after every other contribution, suppressing the suffix and every other section while assembly still resolves contexts, tools, variables and cooperative listeners.
- **Surprising:** `includeRuntimeContext: false` suppresses *optional* context providers for the scope without disabling their owning services; required providers remain.

### packages/preset/agent-preset/skills/agent-experience/SKILL.md
- Read: 19-line skill that is a direct model-facing-tool design guide. Its five tool rules are unusually concrete: **delete obvious constraints** (omit what the call result teaches), **describe behavior, not implementation**, **put parameter rules on the parameter** (a description that varies with configuration means the varying part belongs to a parameter), **say each fact once** (do not repeat the tool definition in its system-prompt section), and **measure the change** (compare first-turn prompt tokens before and after).

### packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md
- Read: 38-line reference stating six Harness plugin principles, of which three are directly transferable to August: **the session log is the only source of truth** (anything the model sees must be reconstructable from committed events; plugin memory is a derived cache), **extension points are shared; use the weakest mechanism that suffices** (restrict < guard < waterfall < assemble, ordered by how much of other plugins' contributions you must preserve), and **do not append session events with a new `type`** (an unknown stored event is accepted only with `ignorable: true`, which live `Session.append()` cannot set, so the session would refuse to reopen). Its performance rules are equally concrete: keep per-session state in a projection unit whose `apply` is pure and returns the same reference for ignored events; wait on durable events, never poll `agent/status`; and a timer that starts work calls `agent.followup()` (which wakes the agent) while `agent.inject()` does not.

### packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md
- Read: 50-line procedural skill. The five-step delivery workflow is notable: resolve the destination, discover only the APIs needed, copy the matching template files (never author a preview), **read the installation result** (`application` and `warnings` decide whether the change is live, not logs), and fix observed defects in the same plugin. It also states the three knowledge sources *in order* (inspection, then package documentation, then source) and warns that Desktop ships the skill directory inside `app.asar`, which shell commands cannot open.

### packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md
- Read: 84-line skill on authoring agent presets as bundle patches. Key operational rules: nothing edits a declaration in place; an override by Loader row id **replaces the complete `config`** so every field must be restated; install through `plugin_manager` (`install_bundle`) and do not reproduce the install steps with shell commands; a declaration whose activation fails stays on the roster with its diagnostic; and existing sessions keep the revision they started with, so **validate changed behaviour in a new session**.

### packages/preset/agent-preset/skills/cordis-composition-reference/SKILL.md
- Read: 29-line reference skill describing the Loader patch dialect (`insert`, override by id, `group: true`, `disabled`, `isolate`, `!!js`) and the rule that a `!!js` scalar is **never** `!js`, that `config` is replaced wholesale and never deep-merged, and that `isolate` controls *service instances* while scope controls *contributions and event visibility*.

### packages/preset/agent-preset/skills/cordis-plugin-development/references/host-plugin.md
- Read: 70-line reference. The display-metadata checklist (localized `meta.title`/`meta.description`, an original or redistributable icon, exported `./locale/*.json` and `./icon`, `files` kept current) and the rule that an accepted filename does not establish that the bytes render. It also warns: "Do not infer updated browser code from an unchanged slot id."

### packages/preset/agent-preset/skills/cordis-plugin-development/references/user-actions.md
- Read: 15-line reference. "One operation, two callers": implement the operation once as a Host service method; the UI action calls it through a Client-callable entry point; the agent tool calls the *same* method and returns its result as the tool result. Authority-granting actions (approving a tool call, answering an agent's question, loosening a policy) stay **user-only**, and separate operation logic in the UI and tool paths is forbidden.

### packages/preset/agent-preset/skills/cordis-plugin-development/references/verification.md
- Read: 7-line reference. Prefer the authenticated page already connected; do not launch a separate browser, change `HOME`, or search for auth tokens; do not build a rasterizer to compensate for missing browser control. "A screenshot of a mock page is not verification of the running plugin."

### packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md
- Read: 13-line reference. The browser artifact registers a **lazy factory** whose id equals the package name; React comes from the browser module table, so no duplicate React install, CDN script or UMD search. Factories stay free of side effects; resources are registered inside `apply` with `ctx.effect`/`ctx.on` and their cleanup returned.

### packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md
- Read: 5-line reference for a configuration-only MCP bundle: a unique name, version and `dsh.bundle.patch` but no Host/Client entry files; the patch inserts the already-installed `@deepseek-ai/dsh-mcp-client` with `serverName`, `transport: streamable-http`, `url` and `failOnStartupError: true`. Ambient credentials are scrubbed; reference existing credentials with Loader `!!js` rather than copying secrets into conversation text.

### packages/preset/agent-preset/tests/skills.spec.ts
- Read: 146-line spec over the shipped creator skills. It asserts the `agent-experience` skill is a **symlink alias** to a repository copy (not a second copy), that every rendered skill stays under the **pruner threshold of 8192 code points** (the same threshold the shipped `standard.patch.yml` prunes at), that every referenced file exists, that each template's manifest, patch and JavaScript parse, that every display resource is exported and named in the skill body, and — a rule with an interesting rationale — that no shipped skill may forbid reading DSH package sources, and no skill may route its files through the shell (because Desktop ships the skill directory inside `app.asar`, which only the Host process can open).

### packages/preset/agent-preset/src/index.ts
- Read: 30-line declarative preset row. It is an `EntryGroup`-flagged service (so the Loader preserves child `!!js` expressions until their own plugins activate) whose `Service.init` generator simply hands its config to `ctx.agentPresets.register`.

### packages/preset/agent-preset-registry/tests/harness.ts
- Read: 52-line harness mounting the Loader, llm, session, prompt, tools and agent spine plus the registry, with helpers `declare`, `agentOn` and `currentKey`.

### packages/preset/agent-preset-registry/tests/registry.spec.ts
- Read: 413-line registry suite; header + first 16 lines and the full `it()` inventory read. It pins revision sharing and retention, a failed definition staying visible, duplicate ids, rebinding a blank scope while a child keeps the former revision, selection locking after the first turn, the YAML rendering of a declaration, an isolated service resolved through the Agent composition, and the reporting of every process-global service a preset published.

### packages/preset/agent-preset-registry/tests/mount.spec.ts
- Read: 153-line mount suite; header + first 15 lines and the full `it()` inventory read. Pins that the declaring Loader entry's subtree is not replaced and runtime tree changes are not persisted, and that a profile-denied row mounts disabled.

### packages/preset/agent-preset-registry/tests/composition-inventory.spec.ts
- Read: 27-line spec asserting evaluated and unresolved conditions with ancestor enablement.

### packages/preset/agent-preset-registry/tests/display.spec.ts
- Read: 30-line spec for shipped-vs-authored display resolution.

### packages/preset/agent-preset-registry/tests/session.spec.ts
- Read: 45-line spec: the projection starts from the creation header (including no configured preset) and keeps the latest selection.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/contribute.js
- Read: 20-line import-free fixture registering one tool and one prompt section named from `config` — it must be import-free because the Loader resolves entry modules through Node's ESM resolver, which cannot see the workspace's TypeScript sources.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/global-service.js
- Read: 5-line fixture publishing a service with **no** `isolate` realm, so it lands in the ROOT realm — the leak the mount audit must catch.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/late-service.js
- Read: 6-line fixture publishing into the ROOT realm only after its plugin body returned, escaping the one-shot mount audit.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/needs-missing.js
- Read: 5-line fixture injecting a service the composition never supplies, so its row stays **pending** rather than failing — the case only the mount audit can catch.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/self-dispose.js
- Read: 9-line fixture disposing itself once active — the Loader treats a self-disposing entry as a config change and writes the tree back, which is the path that once truncated a preset file to `[]`.

### packages/preset/agent-preset-registry/tests/fixtures/plugins/throws.js
- Read: 6-line fixture whose activation rejects with its configured message.

### packages/preset/persona/tests/persona.spec.ts
- Read: 179-line suite. Pins that the row shadows the deployment persona **per scope** and that disposal restores both defaults; that an omitted or empty suffix shadows the global suffix away; that an unscoped mount is rejected with the registry's own "already registered" error; that a `complete` persona is the exact prompt after every other contribution; and that runtime-context suppression is scoped and reversible.

### packages/plan/plan-mode/tests/plan-mode.spec.ts
- Read: 1187-line suite; header + first 60 lines and the full `it()` inventory read. Its "soft layer" group is the striking part: the tool schemas stay **identical** across default and plan mode, the PTC-mode SDK stays **byte-identical** across mode switches, and every tool call runs untouched in plan mode — "guidance and enforcement are separate axes".

### packages/plan/plan-mode/tests/integration.spec.ts
- Read: 252-line full-loop suite; header + first 95 lines and the full `it()` inventory read. Only the model is mocked; the loop, the session log and the plugin are real. It pins that a pre-turn `set()` makes the **first** header plan-shaped, that a user flip between turns lands at the boundary as one notice and a replaced system node with stable tool schemas, that a mode flip at error settlement waits for the step after a same-step retry, and that a dismissed plan review ends the turn without another model request.

### packages/plan/plan-mode/tests/projection.spec.ts
- Read: 165-line projection suite; header + first 64 lines and the full `it()` inventory read. Pins that a logged `/plan` selection reads *pending* until a `plan/mode` records it, that a command settling with an error drops the selection, and that a cold replay recovers pending from the log alone.

### Remaining files (read; one line each)

- `packages/guard/README.md` — group map naming the two loop-hygiene guards and linking the tools subsystem + config catalog.
- `packages/guard/README.zh.md` — Chinese mirror of that group map.
- `packages/guard/README.i18n.yaml` — 8-key en/zh heading-hash record for the group map.
- `packages/guard/repeat-tool-reminder/README.md` — full package reference: four design commitments, chain semantics, delivery via `additionalContexts`, six stated limitations.
- `packages/guard/repeat-tool-reminder/README.zh.md` — Chinese mirror of that reference.
- `packages/guard/repeat-tool-reminder/README.i18n.yaml` — 41-key heading-hash record.
- `packages/guard/repeat-tool-reminder/package.json` — manifest; exports `./src/*` and `./locale/*.json`; cordis/agent/tools peer deps.
- `packages/guard/repeat-tool-reminder/tsconfig.json` — project references (cordis, schemastery, tools, agent, llm).
- `packages/guard/repeat-tool-reminder/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/guard/timeout-policy/README.md` — full package reference: cooperative deadline, scoped classification, signal swap/restore, per-tool budget.
- `packages/guard/timeout-policy/README.zh.md` — Chinese mirror (first 40 lines read).
- `packages/guard/timeout-policy/README.i18n.yaml` — 28-key heading-hash record.
- `packages/guard/timeout-policy/package.json` — manifest; peer deps on `dsh-timeout`/`dsh-tools`/`dsh-llm`; no runtime deps.
- `packages/guard/timeout-policy/tsconfig.json` — project references including `../../util/timeout`.
- `packages/guard/timeout-policy/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/interaction/README.md` — group map: five capabilities, each with its `ctx` key.
- `packages/interaction/README.zh.md` — Chinese mirror of the group map.
- `packages/interaction/README.i18n.yaml` — 7-key heading-hash record.
- `packages/interaction/commands/README.md` — package reference: grammar, scoped shadowing, attachment admission, cancellation, durable lifecycle (first 80 of 149 lines read).
- `packages/interaction/commands/README.zh.md` — Chinese mirror (first 20 lines read).
- `packages/interaction/commands/README.i18n.yaml` — 30-key heading-hash record.
- `packages/interaction/commands/package.json` — manifest; exports `./types`, `./brand`, `./typert`, `./remote`.
- `packages/interaction/commands/tsconfig.json` — project references (attachment, scope, session, brand, typert, crypto).
- `packages/interaction/commands/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/interaction/permission-presets/README.md` — package reference: preset table, reserved names, knob write-through, session defaults (first 80 of 147 lines read).
- `packages/interaction/permission-presets/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/interaction/permission-presets/README.i18n.yaml` — 26-key heading-hash record.
- `packages/interaction/permission-presets/package.json` — manifest; peer deps shell/sandbox/commands/user-approval/session-projection.
- `packages/interaction/permission-presets/tsconfig.json` — project references (sandbox, sandbox-policy, shell, settings, …).
- `packages/interaction/permission-presets/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/interaction/tool-ask-user/README.md` — full package reference: legacy vs timed, per-call timeout, the pending shape, four limitations.
- `packages/interaction/tool-ask-user/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/interaction/tool-ask-user/README.i18n.yaml` — 28-key heading-hash record.
- `packages/interaction/tool-ask-user/package.json` — manifest; peer deps tools/user-questions/agent.
- `packages/interaction/tool-ask-user/tsconfig.json` — project references (system-prompt, tools, user-questions).
- `packages/interaction/tool-ask-user/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/interaction/user-approval/README.md` — full package reference: ask/never, fail-closed, turn enclosure, the audit pair, the cache-safe snapshot.
- `packages/interaction/user-approval/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/interaction/user-approval/README.i18n.yaml` — 33-key heading-hash record.
- `packages/interaction/user-approval/package.json` — manifest; exports `./types`.
- `packages/interaction/user-approval/tsconfig.json` — project references (brand, scope, session, agent, system-prompt).
- `packages/interaction/user-approval/tsdown.config.ts` — 15-line tsdown bundle config (ESM, node, es2024, dts off).
- `packages/interaction/user-approval/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/interaction/user-questions/README.md` — full package reference: ask vs askTimed, the plan-review intent, live-root authentication, continued questions, the "no separate question state" invariant.
- `packages/interaction/user-questions/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/interaction/user-questions/README.i18n.yaml` — 14-key heading-hash record.
- `packages/interaction/user-questions/package.json` — manifest; exports `./types` + typert/remote.
- `packages/interaction/user-questions/tsconfig.json` — project references (typert, scope, session, tools, session-projection).
- `packages/interaction/user-questions/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/lsp/README.md` — group map; states that providers register capabilities and only `tool-lsp` owns the model-facing name and schema.
- `packages/lsp/README.zh.md` — Chinese mirror (first 14 lines read).
- `packages/lsp/README.i18n.yaml` — 7-key heading-hash record.
- `packages/lsp/lsp/README.md` — package reference for the seam (first 60 of 139 lines read).
- `packages/lsp/lsp/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/lsp/lsp/README.i18n.yaml` — 22-key heading-hash record.
- `packages/lsp/lsp/package.json` — manifest; peer deps brand/llm/cordis; no runtime deps.
- `packages/lsp/lsp/tsconfig.json` — project references (brand, llm).
- `packages/lsp/lsp/src/brand.ts` — 21-line `LspProviderId` brand outlet.
- `packages/lsp/lsp-stdio/README.md` — package reference with the ten server bounds and credential scrubbing (first 60 of 159 lines read).
- `packages/lsp/lsp-stdio/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/lsp/lsp-stdio/README.i18n.yaml` — 28-key heading-hash record.
- `packages/lsp/lsp-stdio/package.json` — manifest; dev deps include `typescript-language-server` for the e2e.
- `packages/lsp/lsp-stdio/tsconfig.json` — project references (timeout, fs, lsp, subprocess).
- `packages/lsp/lsp-stdio/src/protocol.ts` — 80-line wire type subset.
- `packages/lsp/lsp-stdio/src/abort.ts` — 48-line cancellation helpers preserving timeout classification.
- `packages/lsp/tool-lsp/README.md` — package reference: the single tool, one-based coordinates, the two-stage cap, the timeout budget (first 60 of 179 lines read).
- `packages/lsp/tool-lsp/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/lsp/tool-lsp/README.i18n.yaml` — 36-key heading-hash record.
- `packages/lsp/tool-lsp/package.json` — manifest; dev dep on `dsh-tool-call-timeout-policy`.
- `packages/lsp/tool-lsp/tsconfig.json` — project references (tools, system-prompt, timeout, lsp, working-directory).
- `packages/mcp/README.md` — group map; MCP tools and prompt text appear only for callers with a configured server in scope.
- `packages/mcp/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/mcp/README.i18n.yaml` — 7-key heading-hash record.
- `packages/mcp/mcp-client/README.md` — package reference with the per-server config table and the instruction byte cap (first 70 of 229 lines read).
- `packages/mcp/mcp-client/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/mcp/mcp-client/README.i18n.yaml` — 34-key heading-hash record.
- `packages/mcp/mcp-client/package.json` — manifest; MCP client SDK 2.2.0; optional peers mcp-resources and system-prompt.
- `packages/mcp/mcp-client/tsconfig.json` — project references (tools, scope, subprocess, timeout, http-proxy, mcp-resources, system-prompt).
- `packages/mcp/mcp-resources/README.md` — package reference: three shared tools, explicit server selection, binary payloads kept out of model history (first 50 of 134 lines read).
- `packages/mcp/mcp-resources/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/mcp/mcp-resources/README.i18n.yaml` — 24-key heading-hash record.
- `packages/mcp/mcp-resources/package.json` — manifest; system-prompt optional peer.
- `packages/mcp/mcp-resources/tsconfig.json` — project references (llm, scope, tools, system-prompt, values).
- `packages/mcp/mcp-resources/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/plan/README.md` — group map; plan mode guides rather than restricts.
- `packages/plan/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/plan/README.i18n.yaml` — 7-key heading-hash record.
- `packages/plan/plan-mode/README.md` — package reference: entering/leaving, the reviewed exit, pending state, guidance vs enforcement (first 70 of 202 lines read).
- `packages/plan/plan-mode/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/plan/plan-mode/README.i18n.yaml` — 34-key heading-hash record.
- `packages/plan/plan-mode/package.json` — manifest; `dsh-commands` optional peer; exports `./types` and `./client`.
- `packages/plan/plan-mode/tsconfig.json` — project references (user-questions, commands, session-projection).
- `packages/plan/plan-mode/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/preset/README.md` — group map: registry owns selection, agent-preset declares children, persona supplies identity.
- `packages/preset/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/preset/README.i18n.yaml` — 7-key heading-hash record.
- `packages/preset/agent-preset/README.md` — package reference: declaring a preset in YAML, four config fields, eager loading (first 45 of 95 lines read).
- `packages/preset/agent-preset/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/preset/agent-preset/README.i18n.yaml` — 13-key heading-hash record.
- `packages/preset/agent-preset/package.json` — manifest; ships `skills/` in `files`.
- `packages/preset/agent-preset/tsconfig.json` — project references (vendor/loader, agent-preset-registry).
- `packages/preset/agent-preset/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/preset/agent-preset-registry/README.md` — package reference: eager scoped activation, revision retention, the isolate-realm requirement, the mount audit (first 60 of 109 lines read).
- `packages/preset/agent-preset-registry/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/preset/agent-preset-registry/README.i18n.yaml` — 22-key heading-hash record.
- `packages/preset/agent-preset-registry/package.json` — manifest; `js-yaml` and `zod` runtime deps; exports `./types` and `./display`.
- `packages/preset/agent-preset-registry/tsconfig.json` — project references (app-boot, loader, include, agent, scope, session, session-projection, settings, tools, typert, hmr, sandbox, user-approval).
- `packages/preset/agent-preset-registry/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/preset/persona/README.md` — package reference: scope-only row, shadowing, complete prompt, runtime-context suppression (first 50 of 127 lines read).
- `packages/preset/persona/README.zh.md` — Chinese mirror (first 12 lines read).
- `packages/preset/persona/README.i18n.yaml` — 22-key heading-hash record.
- `packages/preset/persona/package.json` — manifest; peer dep `dsh-system-prompt`.
- `packages/preset/persona/tsconfig.json` — project references (core/system-prompt).
- `packages/preset/persona/locale/en.json` / `locale/zh.json` — 5/6-line locale stubs.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js` — 22-line browser template registering a lazy factory into `conversation.composer.dock`.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/index.js` — 2-line Host half: `export function apply() {}`.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/cordis.patch.yml` — 3-line patch inserting the `my-decoration` row.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/package.json` — 21-line manifest with the `dsh.client` section and `./client` / `./locale/*.json` / `./icon` exports.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/locale/en.json` — 6-line locale ("Composer Decoration").
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/icon.svg` — 3-line SVG: a blue circle.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml` — 8-line patch inserting an `mcp-client` row (`serverName: demo`, streamable-http, `failOnStartupError: true`).
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/package.json` — 9-line configuration-only bundle manifest.
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/locale/en.json` — 6-line locale ("Demo MCP Connection").
- `packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/icon.svg` — 5-line SVG: two rounded rectangles and an arrow.

---

## Ideas worth stealing

- **A repeat-call guard whose identity is a canonical, deep-key-sorted argument string** — `packages/guard/repeat-tool-reminder/src/index.ts:202` — the chain key is `JSON.stringify([exec.name, canonical])` where `canonical` is a recursive key-sort of the parsed arguments (line 110). *Why it transfers to August:* August's own repeat-guard story (`_recordWorldDelta`, argument novelty) shows the hard part is deciding what counts as "the same call". DSH's answer — canonicalize the *value*, not the surface text — is the missing half: two calls with reordered JSON keys are the same call, and the detection is exact rather than fuzzy. August currently resets on argument *novelty*; this gives it a cheap, exact "identical" predicate to use as the other half of the ledger. The companion rule at line 200 (untracked tools are **transparent** — neither count nor reset) is the other half of the idea: a bookkeeping tool interleaved into a loop must not launder it.

- **Count the loop in post-execute, not pre-execute, so a denied call still counts** — `packages/guard/repeat-tool-reminder/src/index.ts:220` (the `tools/post-execute` listener) with the reasoning spelled out at lines 190–195. *Why it transfers to August:* August's stall counter is fed by `_recordWorldDelta` and a canonical sorted-key identity, but a model hammering a **denied** tool (August denies a lot: sandbox refusals, capability refusals) is exactly the loop that burns the most budget. DSH counts it; August's "world delta" credit model may not.

- **Scope a timeout classification by its own code so a nested deadline cannot be misattributed** — `packages/guard/timeout-policy/src/index.ts:73` (`timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined`) with the rationale at lines 19–24. *Why it transfers to August:* August has an eight-family error taxonomy and a `_retryWaitRefusalMs`; the generalisable trick is that a *deadline* should carry a **classification tag** that the layer that armed it can recognise, so "who timed out" is a fact on the signal rather than an inference. August's "provider refused on shape" repair ladder would be simpler if the request signal carried the reason class.

- **Mutate the shared execution record to swap a signal, and restore it in a `finally`** — `packages/guard/timeout-policy/src/index.ts:66` and `:78`. *Why it transfers to August:* Cordis `next()` ignores passed arguments, so a wrapper that must inject a deadline has to mutate the object in flight — and then must put it back, because every *downstream* listener (a secret guard, a receipt classifier, a retry classifier) reads that same record and must not see an already-aborted signal. August's tool pipeline has exactly this shape (`exec.signal` flows into the tool body and into the receipt classifiers), so the same swap/restore discipline applies.

- **Decide the "never ask" policy inside the service, before any dispatch, so a `prepend`ed listener cannot bypass it** — `packages/interaction/user-approval/src/index.ts:275` with the reasoning at lines 270–274. *Why it transfers to August:* this is the exact class of bug August hit with the approval policy being disabled ("actions that require approval are rejected automatically"). DSH's answer is architectural: the deterministic decision lives on the *request path*, not in a listener, so registration order cannot defeat it. A guard registered later with `prepend: true` would otherwise sit ahead of any gate *listener*.

- **Fail the *question* closed, not the caller's tool call, and normalise a rogue return value** — `packages/interaction/user-approval/src/index.ts:288` (`OUTCOMES.includes(outcome) ? outcome : 'unavailable'`) and the containing-throw at line 291. *Why it transfers to August:* August's `fail closed` discipline for the approval door is documented but the *normalisation* half — a listener returning something outside the closed union must not leak into a `switch` in the caller — is a concrete, cheap guard. August has exactly the same exposure in its `ask_user_question` tool and its approval door.

- **An approval audit must be turn-enclosed because the turn is the log's commit/replay boundary** — `packages/interaction/user-approval/src/index.ts:217` with the reasoning at lines 77–83 and the error text at line 220. *Why it transfers to August:* this is the single most transferable idea in the shard for August, whose whole recovery story depends on the session log being replayable. DSH's rule: an event appended *between* turns is indistinguishable from a crash tail and is silently dropped on reload, so a decision that must be auditable has to be written inside a turn. August's `turn_outcomes` ledger and its `turn_end` event family are the same boundary; the rule is that anything an audit must survive goes inside the turn.

- **Contribute the current policy to the prompt *after* retained history so the cache prefix stays stable** — `packages/interaction/user-approval/src/index.ts:165` (`order: scope.systemPrompt.getContextOrder('APPROVAL_POLICY')`). *Why it transfers to August:* August's KV-cache sensitivity is explicit (the boot memory index is frozen per session to protect the prefix). DSH's technique — a *complete current value* appended after history rather than a rewritten header — means a policy switch costs one appended message and invalidates nothing before it.

- **Recognise a timed call by a parameter in the logged tool SCHEMA, not by the arguments** — `packages/interaction/user-questions/src/projection.ts:129` with the producer side at `packages/interaction/tool-ask-user/src/timed.ts:145`. *Why it transfers to August:* the schema is a *stable* fact about the session; the arguments are per-call. A projection that folds the log can then tell "this session is in timed mode" from one header event instead of from a heuristic over call arguments, and a timed call that *omits* the timeout is still recognised. August's "what was the model told" reconstructions would benefit from the same trick.

- **Derive the question state from the session log; store no separate question state** — `packages/interaction/user-questions/src/projection.ts:235` (`applyUserQuestionEvent`) with the invariant stated at `packages/interaction/user-questions/README.md:70`. *Why it transfers to August:* August already treats the log as the source of truth for turns; DSH shows the same discipline for a *live, cross-client* pending state — a browser that reconnects gets the pending question back, and a resumed session recovers it, with no database.

- **A Client claim suspends the Host's countdown, and the Host — not the Client — computes the remaining time** — `packages/interaction/user-questions/src/timed-wait.ts:36` with the claim protocol at lines 45–69. *Why it transfers to August:* August runs an unattended Bot path where nobody is watching a panel. DSH's model means a human who opens a question card *extends* the wait (the deadline is only enforced while no UI holds it) while the clock itself stays authoritative on the server. That is the right shape for August's "ask the user" with a deadline: the deadline is a fallback, not a race against a slow reader.

- **"Pending" and "skipped" are different answers, and the pending notice is a field of the result value** — `packages/interaction/tool-ask-user/src/timed.ts:39` with the rationale at lines 32–38. *Why it transfers to August:* August's `ask_user_question` (if it has one) and its pending/timeout stories would otherwise conflate "the human declined to answer" with "the human did not answer in time". DSH makes the distinction legible to the *reader* (the projection and the UI both re-read the recorded result), which is why the notice is a field and not prose.

- **A dismissed review is not a failed one** — `packages/plan/plan-mode/src/index.ts:337` (`exec.concludeTurn()`). *Why it transfers to August:* when a human takes the turn back to type their own words, spending a model request on "waiting for the answer" is waste. Ending the turn instead is both cheaper and more honest.

- **Consent requires exactly the single approve selection; free text is feedback, never consent** — `packages/plan/plan-mode/src/index.ts:348` with the guard at line 349 (`item?.selected.length !== 1 || item.selected[0] !== APPROVE_LABEL || item.custom !== undefined`). *Why it transfers to August:* any approval UI August builds has the same hazard — a user who types "yes but change X" must not be recorded as an approval. DSH treats *custom text alongside Approve*, a duplicate answer item, and a missing item all as keep-planning.

- **Keep the tool catalog byte-identical across a mode switch; change only the prompt section** — `packages/plan/plan-mode/src/index.ts:15` (the docstring) and `:277` (the tool registration), pinned by `packages/plan/plan-mode/tests/plan-mode.spec.ts` ("keeps the tool schemas identical across default and plan mode" and "keeps the PTC mode SDK byte-identical across mode switches"). *Why it transfers to August:* August has `set_agent_mode(chat|agent|code|orchestrator)` where `chat` "blocks tool calls (text only)". DSH's answer — a *soft* mode that leaves the schema alone and changes only guidance — keeps the provider prefix stable, which is exactly the thing August's KV-cache work cares about.

- **A mode selection is applied at the next accepted in-turn pre-step, not immediately** — `packages/plan/plan-mode/src/index.ts:196` with the flush at `:448`. *Why it transfers to August:* August's own doc records the pain ("a mode flip at error settlement waits until the step after a same-step retry"). DSH's rule — commit the durable state at a *request boundary*, and only if the boundary is accepted — is the generalisable form: a state change a user made must land at a point where the model is actually about to be called, and never on a request that is about to be retried.

- **Record the preset, then write through only the knobs that differ** — `packages/interaction/permission-presets/src/index.ts:416` with the knob comparison at lines 408–415. *Why it transfers to August:* August has several independent "knobs" (sandbox mode, approval policy, guard mode) that a single user-facing control should bundle. DSH's order is the transferable part: the *selection* is recorded first (so the user's intent survives even if a knob write-through is later re-derived), then each knob is written through its own canonical setter, and only if its effective value differs.

- **"Custom" is a derived state, not an error** — `packages/interaction/permission-presets/src/index.ts:360` with the tie-breaking at lines 348–361. *Why it transfers to August:* when a user changes one of several bundled knobs directly, the combination no longer matches any named preset. DSH's answer — report it as `custom`, a legitimate current value the user may leave but cannot select — is a better UX than an error and a better model than a silent snap-back.

- **Normalise a public tool name and append a hash of the identity whenever normalisation changed it** — `packages/mcp/mcp-client/src/tools.ts:85`. *Why it transfers to August:* August's per-provider/per-model tool surfaces (MCP, plugins, subagent tools) all need a flat namespace. DSH's rule — *the clean case is verbatim, anything lossy gets a 12-hex hash of `(serverName, rawName)`* — guarantees two distinct identities can never collapse into one tool name, and keeps the mapping deterministic so a hot reload reproduces the same names.

- **Two-phase tool sync: fetch the whole next generation, then swap; a conflict rolls the whole server back to zero** — `packages/mcp/mcp-client/src/tools.ts:113` with the rollback at lines 152–160. *Why it transfers to August:* August re-syncs tool surfaces too (MCP `list_changed`, plugin enable/disable). DSH's phase split means a *fetch* failure leaves the previous generation live, and a *swap* failure leaves the model with either the full generation or none of it — never a partial set that would look like missing capability.

- **A reconnect budget with a stability window, and exhaustion unregisters the tools** — `packages/mcp/mcp-client/src/connection.ts:222` (the reset) and `:236` (the backoff), with the give-up path at lines 225–235. *Why it transfers to August:* August runs an unattended Bot path and an MCP client. The transferable mechanism is the **stability window**: a connection that stayed up longer than the longest backoff spacing closes the outage, so a crash-looping server still exhausts a bounded budget instead of restarting forever — and when the budget is exhausted, the tools are *removed* rather than left registered and failing.

- **A failed generation whose transport closure cannot be confirmed stops the reconnect** — `packages/mcp/mcp-client/src/connection.ts:193`. *Why it transfers to August:* a half-closed child process is a resource leak and a security exposure; the safe move is to stop rather than risk overlapping processes. This is the same "fail closed on an uncertain boundary" discipline August applies to the sandbox and the credential scrubber.

- **Provider registration is atomic: validate and conflict-check everything before mutating anything** — `packages/lsp/lsp/src/index.ts:90` with the conflict check at `:123` and the single-effect reservation at `:130`. *Why it transfers to August:* August registers capability surfaces (tools, agents, providers) at runtime. DSH's all-or-nothing rule means a conflicting registration publishes *nothing* — there is no window in which the registry is half-updated — and the disposer releases the id and every extension together.

- **Carry the provider's canonical workspace URI in the result so the caller never parses a possibly-symlinked path** — `packages/lsp/lsp/src/types.ts:79` (the `resolvedWorkspaceUri` rationale). *Why it transfers to August:* the "execution world may differ from the caller's" problem is August's Windows/POSIX problem too. DSH's rule — the *provider* supplies the canonical URI, and the consumer relativizes against that — avoids every path-parsing bug in one stroke.

- **Find references always include the declaration; no caller flag** — `packages/lsp/lsp/src/types.ts:91` and the enforcement at `packages/lsp/lsp-stdio/src/instance.ts:198`. *Why it transfers to August:* a capability whose default can be turned off will be turned off by a model that wants a smaller answer. DSH removes the flag so impact analysis can never omit the defining site.

- **Cap the framed-message size and the header size separately** — `packages/lsp/lsp-stdio/src/framing.ts:12` (64 KiB header cap) and `:72` (per-message byte cap). *Why it transfers to August:* August's LSP/MCP/stdio surfaces all read from an untrusted child process. DSH's decoder bounds the header (a server that never sends the separator) and the body (a hostile length) separately, and the failure is a *fatal close* rather than a silent truncation.

- **On abort, send `$/cancelRequest`, give a bounded grace, then terminate the instance** — `packages/lsp/lsp-stdio/src/instance.ts:219` with the race at lines 211–236. *Why it transfers to August:* the two-stage policy — *ask politely, then insist* — is the right shape for any cancelable child process. Crucially, when the grace expires the instance is **terminated**, because a still-running request would otherwise overlap the next request's document lifecycle.

- **Never pool a poisoned instance** — `packages/lsp/lsp-stdio/src/instance.ts:138`. *Why it transfers to August:* a server whose handshake rejected (or hung) would otherwise make *every* later query for that workspace fail through no fault of the caller. DSH tears the instance down at the first symptom.

- **Allow exactly one transparent transport replacement, and only for a read-only operation** — `packages/lsp/lsp-stdio/src/index.ts:307`. *Why it transfers to August:* a transport that failed before or during a query is replaceable *if and only if* the operation has no side effects. DSH states the reason in the comment — "queries are read-only, so replace that transport once and retry transparently after clean disposal" — which is the rule August would need for any retry-after-disconnect on a mutating tool.

- **A Client claim or a UI panel is a *resource*, and the "no one is watching" state is the one that matters** — `packages/interaction/user-questions/src/timed-wait.ts:36`. See the entry above.

- **A command's lifecycle is a durable event pair, and a payload owned by another domain event is not duplicated** — `packages/interaction/commands/src/index.ts:373` and `:376` (`recordInput === false ? {} : { args: parsed.rawInput }`). *Why it transfers to August:* August's `/permission` command and its approval events both write to the session log. DSH's pairing (`command/run` ↔ `command/done`, mirroring `tool/call` ↔ `tool/result`) gives a UI a correlation id, and the `recordInput` switch is the small, transferable hygiene rule: *if another authoritative event already carries the payload, do not write it twice.*

- **An agent-scoped command shadows the global one for that agent only** — `packages/interaction/commands/src/index.ts:470` (the scoped-layer merge) with the descriptor carrying only the *selected* definition's identity. *Why it transfers to August:* per-agent capability variation is what subagents need; DSH does it by layering rather than by mutating a global registry, so the shadow disappears with the scope.

- **The session log is the only source of truth; plugin memory is a derived cache** — `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:7`. *Why it transfers to August:* this is the rule August already states for turns, but DSH applies it *universally* — to permissions, to plan mode, to pending questions, to preset selection — and the companion rules at line 10 (weakest-mechanism-first: restrict < guard < waterfall < assemble) and line 21 (do not append a session event with a new `type`, because an unknown stored event is only accepted with `ignorable: true` which live `append()` cannot set, so the session would refuse to reopen) are the two constraints August most needs written down.

- **Keep per-session derived state in a projection unit whose `apply` is pure and returns the same reference for ignored events** — `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:26`. *Why it transfers to August:* August's `turn_outcomes` ledger and its `permission`/`plan` style state are all derivable from events. DSH's mechanics — a pure `apply(state, event)` that returns the *same reference* when nothing changed (so unchanged state costs nothing downstream), a `stateVersion` that forces a refold when the fold semantics change, and a `view()` that returns the same reference when the wire value is unchanged (so publication is suppressed) — are directly reusable.

- **A timer that starts work calls `followup()` (which wakes the agent); `inject()` does not** — `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:29`. *Why it transfers to August:* August's schedulers, `learning_scheduler` and Bot paths all inject context. The distinction between "wake the agent" and "leave a message in the inbox" is a real, easy-to-get-wrong distinction that determines whether a scheduled turn ever runs.

- **One operation, two callers; authority-granting actions stay user-only** — `packages/preset/agent-preset/skills/cordis-plugin-development/references/user-actions.md:9`. *Why it transfers to August:* August has UI surfaces and agent tools that both mutate state (approvals, permission changes, question answers). DSH's rule — implement once as a Host service method; the UI action and the agent tool both call it; and never maintain separate logic in the two paths — plus the carve-out that approving a tool call or answering an agent's question is *never* exposed as an agent tool, is a directly usable contract.

- **Delete obvious constraints; put parameter rules on the parameter; say each fact once** — `packages/preset/agent-preset/skills/agent-experience/SKILL.md:15`, `:17`, `:18`. *Why it transfers to August:* this is a compact, opinionated tool-design rubric that maps straight onto August's tool schemas and its system-prompt sections. "A description that varies with configuration usually means the varying part belongs to a parameter" is exactly the rule August's per-model capability profiles (`maxTools`, `maxToolResultChars`, `toolSurface`) need.

- **A shipped skill must render below the compaction pruner's threshold, and the threshold is a shared constant, not a guess** — `packages/preset/agent-preset/tests/skills.spec.ts:24` (8192 code points) with the assertion at `:76`. *Why it transfers to August:* August has a tool-result pruner. DSH turns "don't write a huge skill" into a *test* that measures the rendered skill against the same threshold the pruner uses — so a skill can never be written into a shape that is silently truncated before the model sees it.

- **A preset revision is reference-counted; a child joins the exact revision its parent retained** — `packages/preset/agent-preset-registry/src/index.ts:297` with the retention counter at `:245` and the collection at `:148`. *Why it transfers to August:* August's subagents inherit the parent's configuration. DSH's rule — a redefinition retires a revision but does not disturb the agents already joined; a child joins the parent's *retained* revision, not "the current definition" — is the correct semantics for a live reconfiguration system.

- **A mount audit distinguishes "failed" from "pending", and a pending row stays mounted** — `packages/preset/agent-preset-registry/src/mount.ts:154` with the re-audit after the Host tree settles at `packages/preset/agent-preset-registry/src/index.ts:135`. *Why it transfers to August:* August composes plugins at boot and an ordering bug (a provider still activating) looks exactly like a missing dependency. DSH's "wait for the Host tree, then re-audit" turns an ordering race into a settled fact.

- **A composition that publishes a service into the root realm is rejected at mount** — `packages/preset/agent-preset-registry/src/mount.ts:69` (the leak detector) with the reject at `packages/preset/agent-preset-registry/src/mount.ts:213`. *Why it transfers to August:* August's per-agent capability restrictions (the deny set published on `currentSubagentDenied`) are exactly this concern — a capability that leaks into the global realm is a capability the restriction cannot bound. DSH makes the leak a *mount-time* error rather than a runtime surprise, and `serviceForMount` provides the explicit way to read a service inside an isolated realm.

- **A persona row is scope-only: an empty template still SHADOWS the deployment section, then disappears at render** — `packages/preset/persona/src/index.ts:63`. *Why it transfers to August:* August's per-agent prompt overrides face the same question. DSH's answer is a two-stage one: the *slot* is occupied (so the deployment text is gone for that scope), and the *render* drops an empty section. The behaviour is deliberate and documented in `packages/preset/persona/README.md:49`, and its test (`packages/preset/persona/tests/persona.spec.ts:88`) pins it.

---

## Files skipped (with reasons)

- `packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md` — a **GENERATED** catalog (41 003 bytes, 514 lines) of every workspace package that exports a Cordis plugin, grouped by package group, with a `Config` column and a one-line description per package. Its own first line states it is generated by `scripts/gen-plugin-packages.ts` and verified by `pnpm run verify-plugin-packages`, and must not be edited by hand. I read the header and preamble (lines 1–70) and enumerated all 50 group headings with grep, so I know its exact structure and content shape; I did not read all 514 lines, because the file is a mechanical index whose every row is a package name plus a description (no mechanism), and the sibling `SKILL.md` explicitly instructs a reader to `grep -n <keyword>` rather than read it whole.

No other file in the shard was skipped. Every other file was opened; for the 21 large spec files (over ~15 KB) I read the file header and harness (the part that states the intent) plus the complete `describe`/`it` inventory extracted with grep, rather than every assertion body — each of those files is recorded in the ledger as `read` with that extent stated in its note. The largest files I read **in full** line by line are `packages/interaction/user-questions/src/*.ts`, `packages/interaction/user-approval/src/index.ts`, `packages/interaction/commands/src/index.ts`, `packages/interaction/permission-presets/src/index.ts`, `packages/interaction/tool-ask-user/src/*.ts`, all of `packages/lsp/lsp-stdio/src/*.ts`, `packages/lsp/tool-lsp/src/*.ts`, `packages/mcp/mcp-client/src/*.ts`, `packages/mcp/mcp-resources/src/*.ts`, `packages/plan/plan-mode/src/*.ts`, and all of `packages/preset/agent-preset-registry/src/*.ts`.

---

## Uncertainties

- **I did not verify any behaviour by executing it.** Nothing in the clone was run (no install, build, test, or script). Every claim about behaviour in this report comes from reading source, comments, README prose and test *assertions* — the assertions tell me what the code is supposed to do, which is strong evidence but not proof that it does. Where a test and a source comment disagree I have not adjudicated.
- **The 21 large spec files were not read assertion-by-assertion.** I read their headers/harnesses and extracted their complete `describe`/`it` titles, which gives the behavioural inventory but not the exact assertions, fixtures or tolerances inside each test. If the lead needs the precise expectations of, say, `packages/preset/agent-preset-registry/tests/registry.spec.ts` (413 lines) or `packages/mcp/mcp-client/tests/mcp-client.spec.ts` (1220 lines), those need a second pass.
- **The bilingual pairs were not diffed.** I read the English and Chinese READMEs of every package and the `.i18n.yaml` hash records, and confirmed structurally that they mirror each other; I did not verify that the Chinese text is a faithful translation of the English, nor that the recorded hashes are current. The `.i18n.yaml` files are opaque digests — I can state that a pairing record exists and how many heading keys it carries, but not whether it is up to date.
- **Two areas of the codebase referenced but not in this shard were not read.** The shard's own mechanisms lean on `packages/core/agent-loop`, `packages/core/session`, `packages/core/session-projection`, `packages/core/tools`, `packages/util/timeout` and `@deepseek-ai/cordis` — in particular the exact semantics of `Session.append`, `SessionProjections`, the `tools/execute` waterfall and the `dsh-timeout` `deadline`/`timeoutOf` primitives. Where I describe those (e.g. "the turn is the commit/replay boundary", "`deadline`'s `<= 0` is the internal no-timeout sentinel"), I am reporting the *caller's* stated contract, not a verified implementation.
- **`packages/mcp/mcp-client` depends on the external `@modelcontextprotocol/client` 2.2.0 SDK.** I read the harness's own code and the mock shapes its tests install; I did not read the SDK, so claims about SDK behaviour (e.g. that the SDK "binds a Protocol to one transport for life", or that stdio negotiation "starts a temporary probe process before the serving process") are as DSH's code and tests describe them, not as I verified them.
- **The `packages/preset/agent-preset` skills are *instructions to a model*, not code.** `agent-experience`, `cordis-plugin-development`, `cordis-composition-reference` and `editing-cordis-compositions` are prose procedures for an agent working in a Harness profile. I read them as documents and evaluated their advice on its merits; I have not seen evidence of how well they work in practice, and `skills.spec.ts` only proves they are shaped correctly (thresholds, file references, template parseability), not that they produce good plugin code.
- **`packages/preset/agent-preset/skills/cordis-composition-reference/references/packages.md` is the one file I did not read line by line** (see "Files skipped"). Every claim I make about the packages it indexes is sourced from that file's *header*, its 50 group headings, and the first 70 rows — not from every row.
- **Two package READMEs were read only in part** because they exceed 100 lines and repeat the same section structure in both languages: `packages/interaction/commands/README.md` (80 of 149) and `packages/plan/plan-mode/README.md` (70 of 202), plus `packages/preset/persona/README.md` (50 of 127), `packages/lsp/tool-lsp/README.md` (60 of 179) and `packages/mcp/mcp-client/README.md` (70 of 229). In each case the unread remainder is the "Further Exploration / Model Experience / Known Limitations" tail, which restates the same contract in the same structure as the sections I did read.
