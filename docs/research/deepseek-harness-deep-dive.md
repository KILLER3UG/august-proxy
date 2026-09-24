# DeepSeek Harness — architecture deep dive for August Proxy

**Repo studied:** `https://github.com/deepseek-ai/deepseek-harness.git` (the real, public, ungated repo — no redirect, no rename).
**Commit:** `46a7f68b0922371ce7144b668b90e377d8e799f4` — *"Merge pull request #5073 from deepseek-harness/rel/dsh-0.1.7-rc.1"*, 2026-09-23.
**Local clone:** `C:/Users/rober/AppData/Local/Temp/ref-repos/deepseek-harness`

Every claim below is cited as `path:line` relative to that clone root. DSH is a TypeScript/Node monorepo (~13,300 files) built on **Cordis**, a plugin DI framework: every capability — model adapter, tool registry, session log, and the agent loop itself — is a plugin that can be replaced from configuration (`docs/architecture.md:11-13`).

---

## 1. Agent loop / harness

### 1.1 Turn and step structure

The vocabulary is deliberately small: a **step** is one model request plus the tools it calls; a **turn** is zero or more steps and "opens before its first input is claimed and closes once nothing is owed" (`docs/architecture.md:86`). The loop is `ReactLoopAgent` in `packages/core/agent-loop/src/agent.ts`.

The driver is a `while (await this.turn()) {}` pump with a three-variant phase machine — `idle | maintenance | running` — that owns the `AbortController` for the current activity (`packages/core/agent-loop/src/agent.ts:41-51`, `:251-264`):

```ts
// packages/core/agent-loop/src/agent.ts:251-264
private async kick(): Promise<void> {
  try {
    while (await this.turn()) {}
  } catch (_error) {
    // Reported failures and cancellation are contained at the driver boundary.
  } finally {
    if (this.phase.kind === 'running') {
      const { turn, wakeRequested } = this.phase
      this.setPhase({ kind: 'idle', lastTurn: turn })
      if (wakeRequested && this.inbox.hasPending) this.wakeDriver()
    }
  }
}
```

`turn()` (`packages/core/agent-loop/src/agent.ts:294-378`) is the whole turn algorithm: append `turn/start`, loop over `preStep` → `step/start` → `step()` → `step/end`, then either loop again for a next-step continuation or break. The `finally` at `:364-371` always appends `turn/end` with a non-null reason, so **a turn can never be left unterminated by a normal return path**.

Two things in that loop are worth stealing outright:

**(a) `max-tokens` is sticky across steps** (`packages/core/agent-loop/src/agent.ts:331-336`):

```ts
// max-tokens is sticky: once any step hits the ceiling, later steps
// that complete normally must not downgrade the turn outcome.
const stepEnd = await this.step(decision)
if (turnEnds === null || turnEnds.kind !== 'max-tokens') turnEnds = stepEnd
```

A truncated turn is materially different from a clean one, and a later "completed" step must not launder it.

**(b) The turn-stopping checkpoint is data, not control flow** (`packages/core/agent-loop/src/agent.ts:341-345`). After a step ends, if there is a terminal reason and no next-step input, the loop awaits the serial `agent/turn-stopping` waterfall. A listener that objects calls `agent.steer(...)`; the machine then **re-reads its inbox** — fresh steering runs another step, none closes the turn. The doc states the reason plainly: *"Data decides, so listener order cannot change the outcome"* (`docs/subsystems/core.md:1030-1043`). August's `update_state(phase=…)` self-heal nudge is exactly the kind of "listener has opinions" hook that DSH makes order-independent by re-reading the queue after the hook rather than trusting a return value.

### 1.2 Inbox: three delivery presets, one queue

`Agent` exposes one `send(message, target, wakeup)` plus three fixed presets (`packages/core/agent/src/types.ts:114-141`, implemented at `packages/core/agent-loop/src/agent.ts:153-172`):

| Preset | Target | Wakes driver | Meaning |
|---|---|---|---|
| `followup` | `next-turn` | yes | "the sole ordinary message of its own turn" |
| `steer` | `next-step` | yes | nearest step boundary |
| `inject` | `next-step` | **no** | context that waits for a waking message |

A subtler rule lives in `send` (`packages/core/agent-loop/src/agent.ts:153-160`): waking input submitted **after** active cancellation cannot join the aborted turn, so it is re-targeted to `next-turn` and the wake is latched for replay at convergence. The classification is captured *before* the inbox splice, with an explicit comment that this is so a reentrant `cancel()` from a splice observer cannot reclassify the message.

### 1.3 Streaming and tool-call parsing

DSH has exactly one canonical chunk-to-message assembler, `BlockAssembler` (`packages/llm/llm/src/assembler.ts:38-208`), and the repo says so at `:1-5`: *"This is the single canonical assembly algorithm used by the agent loop to build an assistant message from a chunk stream while logging the raw chunks for replay fidelity."*

Reasoning content is a first-class block type, not a special case. `text-delta` and `reasoning-delta` share the accumulate path but resolve to different block types (`:62-68`, `:110-113`):

```ts
// packages/llm/llm/src/assembler.ts:62-68
case 'text-delta':
case 'reasoning-delta': {
  const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
  if (partial.block) return // closed by block-end; ignore stragglers
  partial.text += chunk.text
  return
}
```

Four tolerance rules that are cheap and prevent real corruption:

1. **Tolerant of delta-only protocols.** No `block-start` is required; `ensure()` synthesizes a partial on first sight (`:98-106`).
2. **First close wins.** A re-`block-end` is ignored, keeping streamed output and the final assembled block in agreement (`:77-84`).
3. **Closed blocks absorb stragglers.** Deltas for an index already closed by `block-end` are dropped so a misbehaving adapter cannot grow memory or corrupt a completed block (`:65`, `:71`, `:79-81`).
4. **max-tokens truncation drops tool calls, not just text** (`:135-150`). A truncated tool call cannot be dispatched safely, and emitted blocks *and* replay metadata derive from the same keep/drop decision so they cannot disagree:

```ts
// packages/llm/llm/src/assembler.ts:135-140
private assembled(): { blocks: ContentBlock[]; replay: ReplayEnvelope | undefined } {
  const all = this.order.map(index => this.assemble(this.mustGet(index), index))
  const kept = this.finish.kind === 'max-tokens'
    ? all.map(block => block.type !== 'tool-call')
    : undefined
```

`interruptedBlocks()` (`:169-179`) is the cancellation analogue: it keeps closed-and-open text/reasoning blocks with non-whitespace content and **omits tool calls entirely**, because interruption precedes dispatch and retaining one would require fabricating a result.

`finish` defaults to `{ kind: 'stop' }` when the stream ended without a terminal frame (`:186-189`).

### 1.4 The assistant-stream settlement protocol

This is the single most transferable idea in the whole repo. `AssistantStreamAttempt` (`packages/core/agent-loop/src/assistant-stream.ts:18-140`) folds one model attempt into (a) one compact durable stream and (b) ordered process-local frames. The contract:

- `settle(eventType, append)` (`:78-97`) **appends the durable event first**, then emits the `end` frame carrying the committed `seq`. If the append throws, it calls `abandon()` and rethrows.
- `abandon()` (`:100-109`) emits an `end` frame with `outcome: { kind: 'abandoned' }` — so a live consumer always learns the attempt ended, even when nothing durable exists.
- Every frame carries `revision` (monotone within one attached agent lifecycle; replacement restarts at 1), `attemptId`, `turn`, `step` (the `AssistantStreamFrame` union, declared in `packages/core/agent/src/runtime-types.ts` and documented at `docs/subsystems/core.md:155-191`).

The call site is where the interesting decisions live (`packages/core/agent-loop/src/agent.ts:427-491`):

- **Interrupted with visible content** → commit `assistant/message` with `interrupted: true`, carrying `interruptedBlocks()` (`:430-447`).
- **Interrupted with nothing streamed, or a stream error** → commit `assistant/attempt` (`:449-459`). An attempt is never silently dropped.
- **Settlement itself throws** → the loop raises an `AggregateError` of `[error, settlementError]` rather than losing either (`:460-466`).
- **Terminal in-band failure** → commit `assistant/attempt` *first*, then run the `agent/request-error` waterfall, and only `continue` the retry loop if a listener returns `{ kind: 'retry' }` (`:469-491`).

The architectural rule behind all of it is stated at `docs/architecture.md:121`: *"Each `assistant/message` embeds the exact compact timed stream that produced its assembled content; `assistant/attempt` retains settled failed, retried, cancelled, and stream-error attempts without adding model history."* So a failed attempt is **durable but not model-visible** — a distinction August currently does not have at all.

### 1.5 Retries

Retry is not in the loop; it is a plugin on the `agent/request-error` waterfall (`packages/llm/llm-retry/src/index.ts`).

- **Policy is provider-owned and resolved at adapter registration** (`packages/llm/llm/src/retry-policy.ts:14-24`, `:149-195`). Defaults: 5 retries, 500 ms initial, 10 s cap, 0.1 jitter, retryable codes `EMPTY_RESPONSE | RATE_LIMIT | SERVER | TIMEOUT | TRANSPORT`.
- **Retry count lives in a session projection, not in memory** (`packages/llm/llm-retry/src/index.ts:125-138`), reset on `step/start` and `turn/end`. A resumed session does not inherit a stale retry budget, and a replayed `llm/retry` event is idempotent (`:135`).
- **Every scheduled retry is durable *before* its cancellable wait** — `llm/retry` is appended, then it waits, then `llm/retry-started` is appended (`:164-191`).
- **Provider-requested delay is honored, but not blindly**: a `providerRetryAfterMs` above `maxDelayMs` degrades to local backoff in `always` mode and gives up (delegates) in `normal` mode (`:226-238`).
- **A `catch`-all `always` mode** exists alongside `normal` (`:199-214`), and it guards the whole delegated call with a fused abort signal so disposal cannot be raced.
- **Teardown drains**: the plugin disposer removes the listener, aborts its lifetime, and awaits every in-flight recovery (`:254-258`).

Error classification is a stable-code vocabulary, not string matching at call sites (`packages/llm/llm/src/error.ts`):

- `HarnessError` carries a `code` distinct from `message`: *"route on this, never by parsing `message`"* (`:13-22`).
- `EMPTY_RESPONSE` exists because *"an empty message silently ends the turn with nothing for the user or the loop to act on"* (`:29-39`). This is exactly the degenerate-output class August already has a file for (`backend-py/app/lib/degenerate_output.py`).
- `INVALID_CREDENTIAL` is deliberately **outside** the default retryable set — *"a malformed credential fails identically on every attempt"* (`:41-48`).
- `isContextWindowExceededError()` is one classifier over five regex families so both thrown and in-band provider errors normalize (`:51-86`).
- `errorChain()` renders the full `cause` chain and `AggregateError` members for humans, with cycle detection and a hostile-getter guard (`:102-154`).

### 1.6 Stop reasons

`TurnEndReasonMap` (`docs/subsystems/session.md:688-723`) is a merge-extensible sum of `completed | aborted | blocked | error | max-tokens | interrupted | forked`. Two of these are **synthesized, never emitted live**:

- `interrupted` — crash recovery closes a turn that had no `turn/end` (`docs/subsystems/persistence.md:108-110`).
- `forked` — fork-seed construction closes a turn that was still open at the fork boundary (`docs/subsystems/session.md:713-719`).

Cancellation carries a typed cause (`user | parent | hook | disposed`) into the durable record (`docs/subsystems/core.md:291-300`). The live loop deliberately copies only the fields `turn/end` records rather than storing the `AbortSignal.reason` object itself, because Node's `fetch` mutates it with a `stack` property that JSON cannot hold (`packages/core/agent-loop/src/agent.ts:71-94`).

### 1.7 Round / tool budgets

**There is no step or round cap in the DSH agent loop.** I searched: the only loop config is `maxParallelToolCalls` (default **10**), at `packages/core/agent-loop/src/constants.ts:6` and wired at `packages/core/agent-loop/src/index.ts:334-335`. Turns terminate on model behaviour, steering, or a `concludesTurn` tool result (`packages/core/agent-loop/src/agent.ts:512-520`).

Bounded looping exists one layer up, as an explicit opt-in product feature: the goal service carries `maxGoalRounds` and the round driver refuses to start past it (`packages/goal/goal/src/types.ts` per `docs/subsystems/goal.md:44-56`; `packages/goal/goal-round-driver/src/index.ts:166-169`). This is the opposite design to August's uncapped `MAX_MANAGED_TOOL_ROUNDS = 0`, and the contrast is worth studying on its own.

### 1.8 Malformed-output recovery

DSH does **not** salvage malformed tool-argument JSON. It preserves it as text (`packages/core/agent-loop/src/agent.ts` → `parseArguments`, `packages/core/agent-loop/src/tool-calls.ts:104-111`):

```ts
// packages/core/agent-loop/src/tool-calls.ts:104-111
/** Parse model arguments, preserving invalid JSON as text and mapping empty input to `{}`. */
function parseArguments(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}
```

The tool's own validator then rejects it as `INVALID_ARGS`, producing a structured error result that the model can read and correct. Recovery is at the *validation* layer, not the *parse* layer. August's `backend-py/app/services/workbench/json_salvage.py` takes the opposite approach (patching the JSON) and is a divergence worth revisiting.

### 1.9 The runtime invariant: model-visible means logged

`packages/core/agent-loop/src/invariant.ts:21-56` installs a global, `prepend`ed `llm/stream` listener that, for every loop-built request, asserts:

```ts
// packages/core/agent-loop/src/invariant.ts:40-43
const expected = session.deriveMessages()
if (JSON.stringify(options.messages) !== JSON.stringify(expected)) {
  fail(`llm request for session "${String(session.id)}" diverges from the dispatch-time durable derivation (log-reconstruction desync)`)
}
```

plus frozen request, live session id, a `step/start` in the log, a foldable `request/header`, and header/message agreement. The architectural statement is at `docs/architecture.md:125`: *"Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it."* This is a single, cheap, machine-checkable guarantee that catches an entire class of "the model saw something we can't reproduce" bugs.

The same rule drives the request freeze in the loop itself (`packages/core/agent-loop/src/agent.ts:629-645`): every derived message is `deepFreeze`d once (tracked in a `WeakSet` at `:119`), the array is frozen, and the request is `markAgentLoopRequest(Object.freeze({...}))`.

### Transferable to August — Area 1

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 1.1 | **P0** | Durable **failed-attempt** record (`assistant/attempt`) that keeps the stream but adds no model history (`agent.ts:449-459`; `docs/architecture.md:121`) | `backend-py/app/services/workbench/kernel.py`, `turn_close.py`, `services/logger.py` | Today a failed/retried attempt leaves no trace in the turn; post-hoc debugging of "why did it retry 3×" is guesswork | M | Low — additive log field |
| 1.2 | **P0** | `max-tokens` sticky at the turn level (`agent.ts:331-336`) | `turn_close.py` | A truncated turn currently reports `completed`; UI and metrics misclassify truncation as success | S | Low |
| 1.3 | **P0** | Drop unsafely-truncated tool calls in the assembler, keeping stream and emitted blocks derived from one decision (`assembler.ts:135-150`) | `backend-py/app/adapters/stream_state.py` | A half-emitted tool call on max-tokens can currently be dispatched with truncated JSON | S | **Medium** — touches the hot streaming path |
| 1.4 | **P1** | Post-turn checkpoint that **re-reads the queue** instead of trusting a listener's decision (`agent.ts:341-345`) | `kernel.py` self-heal nudge, `turn_close.py` | DSH's own doc says listener order must not change the outcome; August's nudge currently can | M | Low |
| 1.5 | **P1** | Every scheduled retry is logged **before** the cancellable wait (`llm-retry/index.ts:188-190`) | `kernel.py`, `services/logger.py` | A crash mid-backoff currently leaves no evidence a retry was pending | S | Low |
| 1.6 | **P1** | Retry budget in a **session projection** reset at `step/start`/`turn/end` (`llm-retry/index.ts:125-138`) | `kernel.py`, `turn_close.py` | Makes retry count replayable and resume-safe instead of process-local | M | Medium |
| 1.7 | **P2** | Runtime invariant asserting the outgoing request equals `deriveMessages()` of the log (`invariant.ts:40-43`) | new `backend-py/app/services/workbench/invariants.py` | Would catch any "model saw unlogged content" bug in CI and at runtime | M | Low (purely additive, dev-flagged) |
| 1.8 | **P2** | No loop-level round cap; bounded looping is an explicit opt-in product feature (`goal-round-driver/src/index.ts:166-169`) | `kernel.py` | Deliberately *not* a copy target — but the framing (explicit budget object vs. global default) is worth adopting for `maxWorkbenchToolLoops` | S | Low |

---

## 2. Subagents / delegation

DSH treats subagents as a **named provider seam** with multiple coexisting backends — fresh in-process agent, forked in-process agent, ACP, Codex, Claude Code, DSH-SDK — behind one `ctx.subagents` service (`docs/subsystems/subagent.md:5-7`).

### 2.1 Two capability-discovery mechanisms

- **One-shot starts** are gated by a static `SubagentCapabilities` descriptor checked *before* a run exists: `agentOptions | outputSchema | depthLimit | toolFilter | persona` (`docs/subsystems/subagent.md:17-36`). A request for an unsupported capability is **rejected loud** — *"never accepted-then-ignored"* (`:15`).
- **Continuable children** are gated by a single optional method, `prepareContinuable`, whose *presence is the capability* — TypeScript narrowing is the discovery mechanism (`docs/subsystems/subagent.md:438-453`).

### 2.2 One-shot vs. continuable

`docs/subsystems/subagent.md:126-136` defines the split: a continuable child is one durable child Session with at most one process-local **Activation**. An Activation is not a request, result, cancellation, or Task — it may run many FIFO turns and stays resident while descendants it created are still running.

```text
# docs/subsystems/subagent.md:128-134
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

**The Agent inbox is the only queue.** There is no second continuation queue (`:148`). `startContinuable()` resolves with `{ childId, messageId }` when the inbox *accepts* the prompt — not when the turn starts, and not when it reaches the log; every earlier failure rejects with neither id and rolls the child back entirely (`:136`).

### 2.3 Result propagation and the output-loss trap

`SubagentResult` (`docs/subsystems/subagent.md:294-325`) is the terminal outcome of a one-shot run:

- `output` is the last **non-empty** assistant message's content; empty-content messages, including usage-only messages, are skipped; without one it falls back to the accumulated assistant text stream, or `[]` (`docs/subsystems/subagent.md:299-305`).
- `structured` is present **only** after a requested `outputSchema` was satisfied — *"requesting a schema does not guarantee it"* (`:306-313`).
- `diagnostic` is provider-authored, scrubbed of tool inputs, file contents, environment values, credentials and raw protocol payloads, and **hard-capped at 4096 UTF-8 bytes** (`:316-321`).
- `stopReason` is merge-extensible; a non-`completed` reason means `output` **may be partial**, and the consumer must map it to an `isError` tool result rather than presenting partial output as success (`:290-292`, `:352`).

The stop-reason union (`docs/subsystems/subagent.md:336-348`) is `completed | aborted | error | max-tokens | refusal`, and the doc is explicit that consumers must *"branch on the known cases and fall through `default`"* because a backend may add variants.

`SubagentRun.result` **does not reject on a child-level failure** — it resolves with `stopReason: 'error'`. Only an unrepresentable infrastructure fault rejects (`:378-383`). Consumers must always `dispose()` to reach quiescence (`:386-389`).

### 2.4 Continuity, settlement notice, and the "no closing message" case

When a resident Activation settles, the manager delivers **one notice** to the durable direct parent describing how the epoch ended, carrying the final assistant text, or the literal string `It left no closing message.` when none remain (`docs/subsystems/subagent.md:202`). It is **unconditional for every child whose id a caller received**, happens *before* the ownership release that would let the parent be judged settled, and reaches a resident parent through the same waking Agent delivery as an agent message (`:202`).

The notice has its own source kind (`SubagentSettledMessageSource`, `:212-221`) precisely so a transcript never credits the child with words it never wrote:

> *"Deliberately a different kind from `AgentMessageSource`: an Agent message is content the sender chose, while this message is the manager stating what became of the child, and a transcript that merged them would credit the child with words it never wrote."*

### 2.5 Authorization is adjacency + liveness

`sendMessage` is the sole model-authored message operation. It *"accepts the exact live sender plus a target id, permits only a direct parent or direct continuable child"* (`docs/subsystems/subagent.md:138`). Siblings, ancestors beyond one edge, self-targets, stale Agent objects, and one-shot children are all rejected (`:150`). Routing is by Activation residency (`:140-145`):

| Target Activation state | `sendMessage` |
|---|---|
| `running` | steer the nearest step in the same Activation |
| `waiting` | wake and steer the same Activation |
| no Activation | cold-resume a new Activation, then steer it |

`interrupt` is fire-and-return: *"the cancel signal is issued before this returns, but the target may keep running until it observes the signal"*, and unclaimed inbox work plus published descendants are preserved while claimed work is **not** requeued (`docs/subsystems/subagent.md:535-548`, `:156`).

### 2.6 Depth, permission, and seeding

- **Delegation depth is durable** — `SessionHeader.delegationDepth` plus runtime `AgentOptions.subagentDepth`, greater-present-value authoritative. *"A runtime-only depth would reset a resumed child to top-level"* (`docs/subsystems/persistence.md:171-176`, `docs/subsystems/subagent.md:465`).
- **Delegated permission is captured before the first await**, then appended to the fresh child. One-shot and continuable share the path; **cold resume reads only the child log** (`docs/subsystems/subagent.md:463`).
- **Fork seeding** passes a *balanced completed-turn prefix* — the parent's events through its last `turn/end` — so the seed is contiguous-from-0 and the replay invariants accept it (`docs/subsystems/subagent.md:466`).

### 2.7 Empty-result / failure handling in the tool layer

A **catalog append failure disposes the run** and handles its result rejection; the caller receives the catalog error even if disposal also fails (`docs/subsystems/subagent.md:668-670`). Provider removal blocks new starts without revoking accepted runs (`:457`, `:643`).

### Transferable to August — Area 2

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 2.1 | **P0** | A guaranteed **settlement notice to the parent** for every child whose id was returned, before ownership release, with an explicit `It left no closing message.` fallback (`subagent.md:202`) | `backend-py/app/services/subagent_orchestrator.py`, `workbench/subagent.py` | Today a subagent that returns empty looks identical to one that was never run; the parent can silently believe nothing happened | M | Low |
| 2.2 | **P0** | Partial output is never reported as success: non-`completed` stop reason → `isError` tool result (`subagent.md:290-292`, `:352`) | `subagent_orchestrator.py`, `workbench/subagent.py` | Directly prevents the "output-loss risk" class | S | Low |
| 2.3 | **P0** | `SubagentResult.diagnostic` is scrubbed and **hard-capped at 4096 UTF-8 bytes**, presented separately from output (`subagent.md:316-321`) | `subagent_orchestrator.py` | Prevents a child's raw error dump from flooding the parent's context | S | Low |
| 2.4 | **P1** | Runtime note source kind, distinct from agent-authored content, so a transcript never misattributes runtime text to the child (`subagent.md:212-221`) | `subagent_orchestrator.py`, `workbench/sessions.py` | August's transcript rows likely blur these two | M | Low |
| 2.5 | **P1** | **Durable** delegation depth so a resumed child cannot be reset to top-level (`persistence.md:171-176`) | `subagent_orchestrator.py`, `workbench/sessions.py` | A restart currently may reset the recursion budget | S | Low |
| 2.6 | **P1** | Delegated permission captured **before the first await** and persisted so cold resume reads only the child log (`subagent.md:463`) | `workbench/permissions.py`, `workbench/grant_policy.py`, `subagent_orchestrator.py` | Closes a TOCTOU window where a permission change mid-spawn lands inconsistently | M | Medium — security-relevant |
| 2.7 | **P1** | Stop-reason union is merge-extensible; consumers fall through `default` to failure (`subagent.md:336-348`) | `subagent_orchestrator.py` | Forces the caller to fail closed on an unknown reason | S | Low |
| 2.8 | **P2** | Capability preflight rejects unsupported start-time features before any resource is created (`subagent.md:15`) | `subagent_orchestrator.py` | Fails loud instead of silently dropping a tool filter or depth cap | M | Low |
| 2.9 | **P2** | Interrupt preserves unclaimed inbox work and published descendants; claimed work is not requeued (`subagent.md:156`) | `subagent_orchestrator.py` | Defines what "stop this subagent" actually means | M | Medium |

---

## 3. Memory & context

### 3.1 Conversation persistence: an event-sourced log

A `Session` is an **append-only log of typed `SessionEvent`s**, and *"The LLM message history is derived from the log, never stored separately; replay is re-derivation from the same events"* (`docs/subsystems/session.md:5`). The event vocabulary is 13 core types (`docs/subsystems/session.md:27-174`), each with a monotonic `seq` and epoch-ms `time`.

Three design decisions in `SessionEvent` are unusually well made:

1. **`ignorable?: true` is opt-in, defaulting to required** (`docs/subsystems/session.md:275-284`):
   > *"A reader meeting an unrecognized type without this marker MUST refuse to reconstruct the session instead of silently dropping the event… defaulting to required means a forgotten marker over-refuses (an inconvenience) rather than silently resuming a gutted session."*
2. **Conditional fields are type-level**, so non-surface events *cannot* carry surface metadata (`docs/subsystems/session.md:259-289`).
3. **Switches over `SessionEvent` must NOT use `assertNever`** because the map is merge-extensible (`:292`).

There is a separate **surface** layer: message-producing events carry a `surfaceOp` of `'append'` or `{ op: 'replace', startSeq, endSeq }` (`docs/subsystems/session.md:317-338`). `SessionSurface` exposes `nodes`, `replaceGeneration`, and `contentGeneration` (`:406-413`) — the latter is what makes "did anything model-visible change?" answerable with a single integer comparison (`agent.ts:395`, `:597`).

`deriveMessages()` is **cached and frozen**: each surface node is projected once, and a surface rewrite rebuilds (`docs/subsystems/session.md:662`). Two subtle rules:

- An **empty-content** `assistant/message` is skipped — a max-tokens step with no content still records the event for its stream/usage/provider/model, but a content-less assistant turn must not enter the provider transcript (`:665`).
- Token accounting expands the embedded stream, but the message's top-level `usage` is the committed-message authority when present (`:669`).

### 3.2 Compaction

`docs/subsystems/compaction.md` documents a three-event log bracket: `compaction/start` → `compaction/summary` → `compaction/end`, all **log-only** (no `surfaceOp`, no model history). The replacement rides on a separate `user/message` with `surfaceOp: { op: 'replace', startSeq, endSeq }` — the only surface mutation summary compaction performs (`:11-17`).

The lock ordering is chosen so a crash is *detectable* (`:19`):

> *"Releasing the lock last turns a crash mid-operation into a detectable orphaned lock (a `compaction/start` with no matching `compaction/end`) rather than a `compaction/end` that falsely claims compaction finished."*

And `session/end-seed` exists specifically to disambiguate that orphan: seed history and live work are byte-identical, so an unmatched opening marker before `session/end-seed` came from the constructor seed and belongs to a dead lifecycle (`docs/subsystems/session.md:731-737`).

**Automatic pressure compaction runs on `agent/pre-step`, before request derivation**; canonical context overflow is handled on `agent/request-error` after the failed step closes, and recovery returns a retry **only when the surface replacement generation advances** (`docs/subsystems/compaction.md:101`, `docs/agent-lifecycle.md:85`). Tool-result pruning runs *before* range selection and remeasures through the token meter, and can advance the surface with **no summary at all** (`:101`).

`shadowedRange` is documented as a **surface-position span, not a numeric seq interval** — after a replacement lands a fresh high-seq summary node at an older range's position, `start` can be *greater than* `end` (`:59-70`). `shadowedSeqs` is the authoritative set.

### 3.3 Result spill and tool-result pruning

DSH does not truncate tool results into oblivion. Two cooperating mechanisms:

- **Spill** (`docs/subsystems/spill.md`): `saveText` persists the **full** text verbatim to a private (0700) session subdir, written with an exclusive `open(path, 'wx', 0o600)` so a planted symlink cannot redirect it, and returns an opaque `SpillLocator` plus a `retrievalHint` telling the model to `read`/`grep` that path (`docs/subsystems/spill.md:90-92`). A save failure is **best-effort**: it keeps the original inline result rather than turning a successful call into an `isError` (`packages/spill/spill-policy/src/index.ts`, the `catch` that returns `undefined` with `ctx.logger.warn`).
- **Token-budgeted retention** (`packages/spill/spill-policy/src/index.ts`): `maxInlineTokens`; when over budget the result becomes ordered head + `\n\n[...]\n\n` + tail + a footer naming the exact omitted byte count and the spill address. Adjacent text blocks are merged because *"Adjacent text has one framing cost on the wire and in the spill preview."*

Separate from retention, `compaction-tool-result-pruner` does deterministic head/middle/tail pruning **by Unicode code point, not UTF-16 code unit, so a retained boundary cannot split a surrogate pair** (`docs/subsystems/compaction.md:225-232`), and each replacement is immediately preceded by a `compaction/prune` **shadow-price** event so pure consumers can subtract it without per-node state (`:237-242`).

### 3.4 Long-term memory / retrieval

**There is no built-in long-term memory in DSH.** The user guide is explicit: *"No memory server is present in the shipped composition, so omitting `--patch` keeps all three disabled"* (`docs/user/guide/mcp-memory.md:31`). The three reference configurations (Memorix, MCP Reference Memory, Engram) are *"interoperability examples only"* (`:5`).

What DSH *does* ship is **session-corpus retrieval**:

- `ctx.sessionQuery` provides cross-session and within-session full-text search with opaque cursors bound to the normalized query + filters + limit (`docs/subsystems/session-query.md:147-198`).
- Query strings are *"interpreted as data, never executable FTS syntax"* (`:161`).
- Semantic text excludes reasoning blocks, blocked prompts, structural events, and stream chunks (`:145`).
- Lineage traces are recursive with a completeness discriminant making "known root" and "missing parent" mutually exclusive (`:226-240`).
- Five read-only model-facing tools hide provider cursors and authorize every result from the immutable calling agent session (`docs/tool-catalog.md`, `tool-session-query` row).

### 3.5 Token accounting

Token estimation is owned by a single `ctx.tokenMeter` seam; the compaction seam explicitly *owns no pricing API* (`docs/subsystems/compaction.md:84`). Image pricing is resolved **per measurement on the routed model** so pressure, retention, and range selection price history the way the request actually sends it, while provider usage stays authoritative for completed requests (`docs/subsystems/llm-streaming.md:256-258`).

### Transferable to August — Area 3

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 3.1 | **P0** | `surfaceOp: {op:'replace', startSeq, endSeq}` as a **typed surface mutation**, with `shadowedSeqs` authoritative and `contentGeneration` as a one-integer change check (`session.md:317-338`, `:59-70` of compaction.md) | `backend-py/app/services/workbench/context_compressor.py`, `workbench/sessions.py` | August's compaction rewrites message lists; a typed span + generation counter makes "did the model context actually change?" exact and cheap | M | Medium |
| 3.2 | **P0** | Unrecognized session event types **refuse reconstruction by default**; `ignorable` is opt-in (`session.md:275-284`) | `workbench/sessions.py` | Fails an inconvenient way instead of silently resuming a gutted session | S | Low |
| 3.3 | **P0** | Empty-content assistant messages are **logged but not derived** into model history (`session.md:665`) | `workbench/kernel.py`, `workbench/sessions.py` | A content-less turn currently pollutes the transcript | S | Low |
| 3.4 | **P1** | Spill oversized tool output verbatim to a private file and return a **locator + retrieval hint**, degrading best-effort on save failure (`spill.md:90-92`) | `backend-py/app/services/workbench/tool_result_cache.py`, new spill store | Gives the model *recoverable* access instead of a lossy truncation; also makes large reads cheap on the wire | L | Medium (new storage surface) |
| 3.5 | **P1** | Compaction lock = log-only open/close bracket released **last**, so a crash is a detectable orphan (`compaction.md:19`) | `context_compressor.py` (`acquireCompactionLock`/`releaseCompactionLock` at `:550`/`:586`) | August's lock is presumably TTL-based in memory; a durable orphan is debuggable, a memory TTL is not | M | Low |
| 3.6 | **P1** | Overflow recovery retries **only when `contentGeneration` advances** (`compaction.md:101`) | `context_compressor.py`, `turn_close.py` | Prevents a retry loop that re-sends the identical oversized request | M | Medium |
| 3.7 | **P2** | BM25-style cross/within-session full-text search with opaque cursors and query-as-data (`session-query.md:147-198`) | new `backend-py/app/services/memory_store/corpus_search.py` + router | August's Brain has `facts` but no session-corpus retrieval; this is how DSH lets the model search its own history | L | Medium |
| 3.8 | **P2** | Prune by **Unicode code point**, never splitting a surrogate pair (`compaction.md:225-232`) | `context_compressor.py` | Python slicing by code unit can split an emoji into invalid text sent upstream | S | Low |

**No built-in long-term memory exists in DSH to copy** — August's Brain/BM25/`remember`/`list_facts` layer is strictly ahead of DSH here. Do not let this report be read as a recommendation to remove it.

---

## 4. Learning / self-improvement

DSH has **no reflection loop, no error taxonomy that steers behaviour, no trajectory-mining, and no training/eval harness** comparable to August's `harness_self_improve.py` / `skill_distiller.py` / `learning_scheduler.py` / `episode_miner.py`. Stating that plainly matters: this is the area where **August is ahead** and DSH offers nothing to copy.

What DSH *does* have, and what is genuinely transferable, is **advisory self-correction as a durable, labeled model-visible nudge** rather than a veto.

### 4.1 Repeat-tool reminder

`packages/guard/repeat-tool-reminder/src/index.ts` is a per-agent repeat-call detector. Four details are the lesson:

**(a) Canonical identity is deep key-sorted, so reordered argument keys are not new work** (`:96-111`):

```ts
/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}
```

**(b) Counting happens in `post-execute`, after `next()` has been delegated, and never vetoes** (`:220-231`):

```ts
ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
  const reminder = observe(exec)
  const downstream = await next()
  if (!reminder) return downstream
  if (downstream.kind === 'block') {
    return { kind: 'block', feedback: downstream.feedback,
      additionalContexts: prependContext(reminder, downstream.additionalContexts) }
  }
  return { ...downstream, additionalContexts: prependContext(reminder, downstream.additionalContexts) }
})
```

The comment explains why counting is *here*: denied calls also flow through this waterfall, *"and a model hammering a denied call is exactly the loop worth breaking."*

**(c) The detection cap and the display cap are separate** (`:42-49`, `:125-128`): the chain key always compares the **full** canonical string; only the quoted preview is truncated to `argumentsPreviewChars` (default 500), because a `write` body would otherwise ride into the next request unbounded.

**(d) A user interjection resets the chain** (`:236-239`) — *"A user interjection changes the context; repetition across it is not a loop."* Note this is a `source.kind === 'user'` check, not a heuristic.

Every reminder carries a distinct source kind so it renders as a notice rather than as a user prompt (`:14-18`, `:60-64`):

```ts
const REMINDER_SOURCE: MessageSource = { kind: 'repeat-tool-reminder' }
```

Escalation is gentle-then-detailed, keyed to `thresholds[0]` rather than a literal count, so a custom first threshold keeps the escalation shape (`:66-74`, `:131-148`).

### 4.2 Trajectory logging

The `ui-trajectory` client module (`packages/client/ui-trajectory/src/`) is a **second rendering target over the same session events**, not a separate logging system. `docs/subsystems/conversation.md:22`: *"Chat and Trajectory may recognize the same durable event family, but each keeps its own Definition State and final node payload."* A trajectory view is therefore a projection, not an audit pipeline.

### 4.3 LLM-backed authorization reviewer (experimental)

`packages/experimental/auto-review/src/index.ts` is a model-based permission gate — *not* learning, but a notable example of prompt-as-policy. Its `REVIEW_POLICY` constant (`:42-57`) is a ~1,500-character fixed policy with a closed JSON output grammar, an explicit three-level risk taxonomy (low/medium/high), and a hard rule that **no instruction can downgrade a risk class or authorize a high-risk action** — including a direct parent's. August's verifier gate was removed by user request; this is the *opposite* feature (an enforced critic), so it is context, not a recommendation.

### 4.4 What is absent

- No reflection / self-critique step in the turn.
- No error-taxonomy-driven behavioural steering (DSH's `LlmFailure.code` taxonomy routes *retries*, not behaviour).
- No eval harness in the loop. The `benchmarks/` directory holds **performance** benchmarks only (`session-open`, `active-stream-reconnect`, `long-session-browser`, `terminal-io`, `agent-continuation`, `conversation-fold`, `support`) — no model-quality evals.

### Transferable to August — Area 4

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 4.1 | **P0** | Canonical repeat detection on **deep key-sorted** arguments, so reordered keys are not new work (`repeat-tool-reminder:96-111`) | `backend-py/app/services/workbench/tool_guardrails.py` (`_hashArgs` at `:252`, `ToolCallTracker` at `:45`) | Matches August's documented canonical sorted-key identity rule; confirm the two agree key-for-key | S | Low |
| 4.2 | **P0** | The nudge is **advisory and durable**, delivered as `additionalContexts` on the tool decision, not a veto (`repeat-tool-reminder:220-231`) | `tool_guardrails.py` | Keeps the tool pipeline's monotonic-guard contract intact (see Area 5) | S | Low |
| 4.3 | **P1** | A user interjection **resets** the repeat chain (`repeat-tool-reminder:236-239`) | `tool_guardrails.py` (`record_user_message` at `:222`) | Prevents a false positive across a genuine context change | S | Low |
| 4.4 | **P1** | Detection cap ≠ display cap: the chain key is the **full** canonical string; only the quote is truncated (`repeat-tool-reminder:42-49`) | `tool_guardrails.py` | Bounds prompt growth without weakening detection | S | Low |
| 4.5 | **P2** | Every nudge carries a distinct `MessageSource` kind so it renders as a notice, not a user prompt (`repeat-tool-reminder:60-64`) | `workbench/emit_types.py`, `workbench/sessions.py` | Stops self-heal text from being replayed as if the user said it | S | Low |
| 4.6 | — | **No reflection/eval/trajectory-mining to copy** | `harness_self_improve.py`, `skill_distiller.py`, `learning_scheduler.py`, `episode_miner.py` | August's learning layer is ahead; do not regress it | — | — |

---

## 5. Tool system

### 5.1 The definition

`ToolDefinition` (`docs/subsystems/tools.md:27-103`) is a model-facing `ToolSchema` plus a **mandatory canonical output declaration**, an `execute` function, and optional host-only callbacks. Two hard rules:

- `schemas()` builds the model-facing projection by an **explicit allowlist** — `output`/`execute`/`projectContent`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` *"must never leak into a model request"* (`docs/subsystems/tools.md:11`).
- The `output` contract is **mandatory** and pure: `render(args, value) → ContentBlock[]` plus optional `presentationMeta` (`:15-23`).

Arguments are losslessly snapshotted and frozen before policy; call identity, caller signal, and the registry token are readonly (`docs/subsystems/tools.md:296-309`).

### 5.2 The execution pipeline

Seven stages (`docs/tool-execution-pipeline.md`):

```
tool/call logged → presentCall(args) → tools/pre-execute waterfall
  → monotonic guards → approval (ask) → tools/execute waterfall (around-dispatch)
  → tool body → projectContent → tools/post-execute waterfall
  → registry normalization → finalizeContent → tools/result
  → tool/result logged → presentResult(args, result) → additionalContexts at next step
```

**The monotonic-guard design is the standout.** `ToolGuard` returns `string | undefined` — a reason denies, `undefined` abstains, and **there is deliberately no "allow" result** (`docs/subsystems/tools.md:325-337`):

> *"Because guards have no allow result, listener ordering cannot turn a denial back into permission."*

Policy decisions are typed decisions, not booleans (`docs/subsystems/tools.md:400-427`):

- `PreToolDecision` = `allow | deny{reason,info?} | cancel | ask{reason?}`. **Input rewriting is excluded** because *"arguments are already logged and presented"* (`:404-408`).
- `PostToolDecision` replaces either content **or** value, never both; a `block` removes the value and becomes an `isError` carrying corrective feedback (`:416-425`).
- Only `allowed-once` proceeds; *"a non-grant, missing approval channel or service, or agent-less request becomes a denial"* (`:427`).

Unknown and throwing tools both become structured errors (`ToolNotFoundError` → `UNKNOWN_TOOL`) so the call fails without ending the turn (`:429`). A `tools/execute` wrapper may replace the signal but the registry **re-fuses the original caller signal** before the body, so replacement cannot detach caller cancellation (`:313-323`).

### 5.3 Parallel tool calls: barriers, ordering, and honest results

`packages/core/agent-loop/src/tool-calls.ts` is the scheduler. Its header states the whole contract (`:1-11`):

> *"Exclusive calls form barriers; parallel calls use a bounded rolling pool and are reclassified before start. Dispatch may overlap, while policy, results, and result context remain model-ordered."*

Four rules with real teeth:

1. **Mode is re-read immediately before every start** (`:85-90`, `:199-206`) — *"Commit before classifying again so registry changes affect unstarted calls."* A registry change mid-step can create a new barrier.
2. **Results commit strictly in model order** via a contiguous `commitReady()` cursor (`:146-161`) — concurrency never reorders what the model sees.
3. **Abort drains started calls, then fabricates honest synthetic results for unstarted ones** (`:238-243`, `:249-260`):

```ts
// packages/core/agent-loop/src/tool-calls.ts:250-259
function appendSkippedToolCall(session: Session, turn: number, step: number, block: ToolCallBlock): void {
  const callSeq = appendToolCall(session, turn, step, block)
  appendToolResult(session, turn, step, block, {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: { message: 'tool call aborted before dispatch',
             info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH } },
  }, callSeq)
}
```

This exists because *"Abort records synthetic error results for skipped calls so replay stays valid"* (`:8-9`). A tool call with no result is an invalid provider transcript.

4. **A terminal scheduler failure preserves real `tool/call` events without fabricating results** (`:9-11`, `:232-236`) — the opposite choice for the opposite situation, and it is deliberate.

Concurrency classification is **fail-closed**: *"Only an exact `true` is parallel; unknown, hidden, undeclared, invalid, or throwing classifiers are exclusive"* (`docs/subsystems/tools.md:572-578`).

### 5.4 Tool presentation is a typed render-intent union

Tools describe how they should render, provider-neutrally, with a discriminated `card:` tag (`docs/subsystems/tools.md:486-491`): `generic | terminal | diff | search | read | web` for both call-time and result-time. Three details matter:

- `presentCall`/`presentResult` are declared **pure and side-effect-free** because *"a UI may call it during live streaming AND a session-log replay"* (`:85-103`).
- Search and web views carry `truncated`/`total` so *"a UI never presents a partial result as complete"* (`:489`).
- The body is not duplicated into the view; a UI lacking the card falls back to raw result content (`:489`).

### 5.5 Capability filtering

`ToolRestriction` is a per-scope `{ allow?, deny? }` filter over **global** tools (`docs/subsystems/tools.md:167-178`). Restrictions intersect across the scope chain; the scope's **own** registrations stay exempt, *"so a delegated child keeps the tools it answers through"* (`:165`). For subagents this is *visibility not authority* — the tools vanish from the child's prompt **and** refuse to execute (`docs/subsystems/subagent.md:93-96`).

### Transferable to August — Area 5

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 5.1 | **P0** | Monotonic guards with **no allow result** — a guard can only abstain or deny, so listener order cannot un-deny (`tools.md:325-337`) | `backend-py/app/services/workbench/managed_tool_policy.py`, `workbench/permissions.py` | A single ordering bug in August's guard stack could currently widen permission | M | Medium — security-relevant |
| 5.2 | **P0** | Synthetic **ordered error results for tool calls skipped after abort**, so the provider transcript stays valid (`tool-calls.ts:249-260`) | `workbench/kernel.py`, `workbench/parallel_tools.py` | Skipped calls currently risk an orphaned `tool_call` with no `tool_result` — a 400 from strict gateways | S | Low |
| 5.3 | **P0** | Explicit **allowlist** for the model-facing schema projection (`tools.md:11`) | `workbench/tool_defs_cache.py`, `workbench/prompt_build.py` | Prevents `execute`/`timeoutMs`/presentation callbacks leaking into the wire — the class of bug behind August's `session_id: null` incident | S | Low |
| 5.4 | **P1** | Parallel mode re-classified **before every start**; results commit in **model order** via a contiguous cursor (`tool-calls.ts:85-90`, `:146-161`) | `workbench/parallel_tools.py` | Registry/policy changes mid-step are honoured; concurrency never reorders model-visible results | M | Medium |
| 5.5 | **P1** | Fail-closed concurrency classification — only exact `true` is parallel (`tools.md:572-578`) | `parallel_tools.py` | A throwing classifier must not accidentally opt a tool into parallelism | S | Low |
| 5.6 | **P1** | Approval is `allowed-once` only; a missing/throwing/mismatched answerer becomes `unavailable` → **deny** (`tools.md:427`, `docs/subsystems/approval.md:24-28`) | `workbench/grant_policy.py`, `workbench/permissions.py` | Fail-closed on every degradation path | S | Low |
| 5.7 | **P1** | Tool result carries a **mandatory canonical `value`** plus rendered `content`; the value is execution-local and never persisted (`tools.md:351-362`, `:392`) | `workbench/tool_result_cache.py` | One validation point instead of per-tool output drift | M | Medium |
| 5.8 | **P2** | Typed `card:` render-intent union with `truncated`/`total` honesty signals (`tools.md:486-491`) | `frontend/desktop/src/components/chat/tool/ToolCallItem.tsx`, `ToolCallItemBody.tsx`, `tool/models.ts` | August's tool UI is per-tool ad hoc; a shared union would make truncation visible everywhere | L | Medium |
| 5.9 | **P2** | Scoped tool filter with **own registrations exempt**, documented as *visibility not authority* (`tools.md:165`, `subagent.md:93-96`) | `managed_tool_policy.py` | Correct model for subagent tool restriction | M | Medium |

---

## 6. UI/UX

DSH has **no TUI**. The shipped surfaces are a browser Web UI (`apps/web`), an Electron desktop app (`apps/desktop`), an ACP automation server, and an SDK JSON-RPC server. `apps/cli` is only a launcher (`apps/cli/src/bin.ts`, `profile-boot.ts`, `plugin.ts`) — there is no terminal UI in the current tree.

### 6.1 The conversation assembly model

`docs/subsystems/conversation.md` describes a target-neutral assembly layer. Each session runs one `ConversationNodeAssembler`; the Session Controller owns a contiguous loaded event window, and every entry is either a durable event or a client-only `assistant/live-chunk` transient (`:11`).

The rules a UI author must follow:

- **Every event contributing to the same Node must carry a stable business id, or derive it independently from its own payload; the client must never assign an update to "the latest unfinished" Context** (`:58`).
- **Durable and transient events may both be starts**; the earliest loaded start initializes state, later matches update it; update-only evidence stays pending until its start is loaded (`:16`).
- Each `(kind, id)` has at most one start event (`:68`).
- *"A transient event may initialize a Context. A named tool delta and its later `tool/call` can both match as start under the same `callId`; only the earliest calls start(), and later Matches call update()"* (`:72`).
- **Reconnect baselines expand the active compact stream into the same transient events**, while durable settlements embed complete streams for history replay; *"Historical pages do not expand settled messages into live deltas"* (`:72`).

### 6.2 The client-side stream fold

`ClientAssistantStream` (`packages/api/session-controller/src/client/sessions/assistant-stream.ts`) is the reconnect-safe join between live frames and durable settlements. It is 230 lines and every branch is about **not losing or double-rendering**:

- `replace(entries, baseline)` (`:58-102`) rebuilds the durable window, resets transient counters, adopts an in-flight attempt, and re-expands the compact baseline into synthetic transient chunks. Transient seqs are *fractional* — `durableCursor + 1 - 1/(n+1)` (`:88`, `:158`) — so they interleave without ever colliding with a durable seq.
- `acceptFrame` (`:129-197`) returns `{ type: 'rebaseline' }` on **any** desync: a start while another attempt is live, an out-of-order chunk index, a wrong attemptId, an end whose index does not match, or an end whose durable settlement was never seen. A rebaseline is not an error; it is a request to re-fetch truth.
- Transient rows for a **successful** message are retained until the owning `step/end`, then retired with `retireAttemptId` (`:189-192`, `:213-218`). Interrupted messages, failed attempts, and abandonment retire immediately (`:124-126`).
- A settlement arriving before its attempt starts publishes directly (`:114-119`); one arriving while the attempt is live is *staged* in `pending` (`:116-117`).

### 6.3 Partial tool arguments during streaming

`packages/client/ui-tool/src/client/tool/tool-call-arguments-partial.ts:13-25` binds a hook that reads `block.argsRaw` — the **raw, unparsed** argument prefix — through `useSyncExternalStore`, per callId. So the UI can show a shell command or a file path *while the model is still emitting it*, without waiting for valid JSON. This is the right way to render a tool call in flight.

### 6.4 Composer and queue

`packages/client/ui-conversation/src/client/input/` holds the editor state machine (`machine.ts`), submission policy (`submission-policy.ts`), and decorations; `queue/QueueDock.tsx` is the queued-input dock. The backend counterpart of that dock is the `Inbox` splice API described in Area 1.2 — the UI edits a durable projection, not a local array.

### 6.5 Approvals in the composer

`docs/subsystems/approval.md:69-80` — the approval request deliberately **omits tool arguments**: *"an answerer attaches the prompt to the already-streamed tool call through `callId` instead of rendering a second copy that could drift."* That is a small, high-value UI rule.

### Transferable to August — Area 6

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 6.1 | **P0** | Reconnect-safe client stream fold: stage durable settlements until their attempt ends, and return a **`rebaseline`** action on *any* desync rather than rendering a wrong transcript (`assistant-stream.ts:109-197`) | `frontend/desktop/src/api/workbench/stream.ts`, `streamEvents.ts`, `components/chat/*` | A dropped SSE frame today can permanently corrupt the visible transcript | M | Medium |
| 6.2 | **P0** | Render the **raw, unparsed** tool-argument prefix during streaming (`tool-call-arguments-partial.ts:13-25`) | `components/chat/tool/ToolCallItem.tsx`, `ToolCallItemBody.tsx` | Tool calls render instantly instead of popping in at completion | S | Low |
| 6.3 | **P0** | Approval prompts carry only `callId` — never re-render arguments (`approval.md:69-80`) | `components/chat/ActionNeededCard.tsx`, `SandboxModeSelector.tsx` | Kills a whole drift class between the streamed call and the permission prompt | S | Low |
| 6.4 | **P1** | Every UI node is keyed by a **stable producer-owned business id**; never "latest unfinished" (`conversation.md:58`, `:68`) | `components/chat/ThoughtStep.tsx`, `SubagentTimeline.tsx`, `TaskProgressPill.tsx` | Concurrent tool calls and subagent updates currently risk landing in the wrong row | M | Medium |
| 6.5 | **P1** | Durable and transient events may both be starts; earliest wins (`conversation.md:16`, `:72`) | `streamEvents.ts`, `api/ui-events.ts` | Streaming tool deltas and their durable `tool/call` must not create two nodes | M | Medium |
| 6.6 | **P1** | Transient rows retained until the owning `step/end`, then retired (`assistant-stream.ts:189-218`) | `streamEvents.ts` | Prevents a double-render at settlement time | M | Medium |
| 6.7 | **P2** | Composed-forced `rebaseline` on any index/attempt mismatch (`assistant-stream.ts:149`, `:176`) | `stream.ts` | A cheap self-heal instead of a visible transcript artifact | M | Low |
| 6.8 | — | **No TUI exists to learn from** | — | August's CLI/TUI ambitions have no DSH precedent | — | — |

---

## 7. Settings / configuration

### 7.1 The config stack

Configuration is **layered patches, not a settings file**:

- A **profile** is a named composition listing bundles, out-of-tree plugins, and the user's `cordis.patch.yml` (`docs/architecture.md:17-19`).
- A **bundle** is a distribution format for config rows and the code they mount, so *"whatever it inserts stays patchable by the layers above it"* (`:21`).
- Layers apply in order: each bundle in profile order → profile patch → home-level patch → `--patch` overlay (`:27`).
- `dsh --profile web --dump-config` prints the exact tree the machine boots; *"Any row it prints can be replaced by a patch of your own"* (`:33-39`).

### 7.2 The settings service

`docs/subsystems/settings.md`:

- A form namespace is the **local id of a uniquely addressed entry** in the active profile; multiple plugin instances get separate forms when their entry ids differ (`:9`).
- Descriptors carry resolved values, inherited values, explicit profile overrides, and an **optimistic revision** (`:9`).
- Three edit verbs with distinct semantics (`:13`): `update` merges; `replace` resets live fields to inherited config first; `mutate` addresses individual paths, **preserving secrets absent from a client response**.
- **Every write validates the complete Config and refuses stale revisions before persistence** (`:13`).
- `ctx.settingsController` forces `redactSecrets: true` on every remote read, so `role('secret')` cannot ride a response, and classifies refusals as `settings/conflict` or `settings/rejected` (`docs/subsystems/settings.md:79`).
- A native text-editor escape hatch exists: `openSettingsDocument()` materializes the provider-owned YAML and opens it (`docs/subsystems/settings.md:122-128`).

### 7.3 Fail-loud configuration

Misconfiguration throws at plugin load, never falls back. E.g. `repeat-tool-reminder` (`:28-34`, `:135-148`, `:176-178`): an empty `thresholds`, a non-integer, a value below 2, or a duplicate throws. And `llm-retry` refuses to own the policy at all (`:30-37`):

```ts
if (key === 'retryPolicy') {
  throw new Error('llm-retry: retryPolicy belongs under each provider configuration')
}
```

Retry policy resolution itself validates exhaustively — unknown keys rejected, `initialDelayMs <= maxDelayMs` enforced, duplicate `retryableCodes` rejected, empty list rejected (`packages/llm/llm/src/retry-policy.ts:115-119`, `:127-138`, `:170-178`).

### Transferable to August — Area 7

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 7.1 | **P0** | **Optimistic revision** on every settings descriptor; every write refuses a stale revision (`settings.md:9`, `:13`) | `backend-py/app/services/config_service.py`, `live_config_service.py`; `frontend/desktop/src/hooks/useSettingsAdvancedPreference.ts` | Two windows editing model/pricing config can silently clobber each other today | M | Low |
| 7.2 | **P0** | `mutate` applies path edits **resolved against stored state, not against whatever the caller last read**, preserving secrets absent from the response (`settings.md:13`, `:113-120`) | `config_service.py` | Prevents a stale-client write from reverting a redacted API key to empty | M | Medium — touches credential persistence |
| 7.3 | **P0** | Forced `redactSecrets: true` on every remote settings read (`settings.md:79`) | `routers/config.py`, `frontend/desktop/src/api/api-client/manage.ts` | Defence in depth behind whatever the frontend does | S | Low |
| 7.4 | **P1** | Misconfiguration **throws at load**, never silently defaults (`repeat-tool-reminder:28-34`, `llm-retry/index.ts:30-37`) | `config_service.py`, `workbench/providers.py` | A typo'd budget silently becoming a default is how safety knobs stop working | S | Low |
| 7.5 | **P1** | Refusals classified as `settings/conflict` vs `settings/rejected` (`settings.md:79`) | `routers/config.py` | Lets the UI distinguish "retry" from "fix your input" | S | Low |
| 7.6 | **P2** | A native "open the config document" escape hatch (`settings.md:122-128`) | `frontend/desktop/src/components/settings/*` | Power users get out of the form system entirely | S | Low |
| 7.7 | **P2** | Layered patch model with `--dump-config` for the composed tree (`architecture.md:27`, `:33-39`) | `config_service.py` | Would be a large change; only worth it if August wants user-authored plugin layers | L | High |

---

## 8. Lifecycle

### 8.1 Startup and shutdown

Boot composes a plugin tree from ordered layers (`docs/architecture.md:17-29`). HMR coordinates watching and reloads; the launcher provides profile data and readiness (`:29`).

The CLI is a **bounded, escalating shutdown controller** (`apps/cli/src/process-shutdown.ts:1-60`):

- 5 s grace (`PROCESS_SHUTDOWN_TIMEOUT_MS`, `:4`) before a forced exit.
- `shutdown(code)` and `interrupt(code)` **coalesce** on a shared `pending` promise (`:51`); a repeated signal escalates.
- `completeOnce` / `forceExitOnce` are independently latched, so a natural-completion path can never race a forced exit (`:38-49`).

`docs/defensive-patterns.md:21` states the rule behind it: *"Dispose must reach quiescence, not just request it. A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup async and await the children's exit (kill → await `done`), and close listener/notification registries BEFORE killing so late completions stay silent."*

### 8.2 Session restore and crash recovery

A log crashed mid-turn ends with an open `turn/start` and no `turn/end`. **Persistence does not truncate or repair it** — *"a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash"* (`docs/subsystems/persistence.md:108-110`). Repair is the **reader's** job:

> *"resume (agent-loop) reads the stored log through its write handle, computes `interruptedTurnClosers` — missing tool errors, any open `step/end`, and a synthetic `turn/end { reason: { kind: 'interrupted' } }` — and appends them through the same handle as an ordinary batch before publishing the Session."*

So a resumed session is never published in a broken state, and the repair is visible in the log like any other event. Read-only observers (session-query) do the same balancing **in memory only, writing nothing back** (`:112`).

The write-behind model is explicit (`docs/subsystems/persistence.md:106`): `session/event` is a synchronous notification; the backend routes it into a bounded window without blocking the producer; **only a resolved `flush` promises crash durability**; a rejected background write retains its events in order, pauses the automatic path, and is retried by the next explicit flush.

Format migration is strict: a backend **refuses** a log it cannot faithfully interpret with `SessionFormatUnsupportedError`, distinct from corruption (`:187-189`). Committed generation paths are never renamed, replaced, or deleted (`docs/architecture.md:123`).

### 8.3 Updates and fatal recovery (desktop)

`apps/desktop/src/` carries the full desktop lifecycle: `host-process.ts` (`DesktopHostProcess`, `DesktopHostUncleanExitError`), `fatal-recovery.ts`, `crash-report.ts`, `update-coordinator.ts`, `update-journal.ts`, `mandatory-update-policy.ts`, `single-instance.ts`.

`DesktopFatalRecovery` (`apps/desktop/src/fatal-recovery.ts:46-60`) is the most reusable piece: **the first fatal failure in a process is the only one reported**; duplicates resolve immediately. The crash report is written **first**, bounded by `CRASH_REPORT_WAIT_MS = 1000` (`:20`), so the dialog can name the file; a slow or failed write still shows the dialog, just without a path (`:57-59`). The dialog detail is tail-bounded to 8 lines within a 1,200-character budget, with a surrogate-safe slice so a truncated error never starts with a lone low surrogate (`:25`, `:34-35`).

### 8.4 Load-bearing lifecycle rules from `docs/defensive-patterns.md`

Each of these is a class of defect that *actually shipped* here (`:5`):

- **Report orthogonal outcomes independently** (`:7-9`): a process can time out *and* exit 0. Surface `timedOut`, `signal`, `exitCode` separately. This is why `ChangeResult.packageResult` records `timedOut` and boot.md insists *"A terminated run is classified `timeout` whatever exit status the signal left behind"* (`docs/subsystems/boot.md:25`).
- **Honor public contracts on BOTH sides** (`:11-13`): adapters may throw *or* emit `finish {kind:'error'}`, but `LlmRuntime.stream()` exposes failures **only** as terminal finish chunks. Consumers never guess where a caught exception came from.
- **Async state is not synchronous state** (`:15-17`): `agent.followup()` has no per-message result; several queued follow-ups can share one `running` interval.
- **Never hand untrusted output the ambient environment or predictable paths** (`:27-29`): scrub `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`; private 0700 dirs, random names, exclusive `'wx'` 0600 opens.
- **Unlink link-shaped paths** (`:31-33`): `lstatSync().isSymbolicLink()` then `unlinkSync`; on Windows `rmSync` on a junction throws `ERR_FS_EISDIR` and recursive removal can descend *into the target*.

### Transferable to August — Area 8

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 8.1 | **P0** | Crash repair is **the reader's job**: append missing tool errors, an open `step/end`, and a synthetic `turn/end {interrupted}` *before publishing* the session (`persistence.md:110`) | `backend-py/app/services/workbench/durability.py`, `checkpoint_service.py`, `main.py` | A crashed session currently resumes with an unbalanced bracket that strict gateways reject | M | Medium |
| 8.2 | **P0** | `interrupted` and `forked` are stop reasons **synthesized, never emitted live** (`session.md:713-723`) | `workbench/turn_close.py` | Distinguishes "the process died" from "the model finished" in every readout | S | Low |
| 8.3 | **P0** | First-fatal-only, report-then-dialog with a bounded write wait (`fatal-recovery.ts:46-60`, `:20`) | `frontend/desktop/src-tauri/src/*`, `main.py` | Prevents error-dialog spam and guarantees the crash file is on disk | S | Low |
| 8.4 | **P1** | Coalescing, escalating shutdown with a hard grace timeout (`process-shutdown.ts:4`, `:38-60`) | `backend-py/app/main.py`, `frontend/desktop/src-tauri/src/lib.rs` | Bounded, single-shot shutdown; no orphan Tauri sidecar | S | Medium |
| 8.5 | **P1** | `timedOut` / `signal` / `exitCode` reported **independently** (`defensive-patterns.md:7-9`, `boot.md:25`) | `services/daemon_manager.py`, `workbench/terminal_service.py` | A run that was killed must never read as a clean exit-0 success | S | Low |
| 8.6 | **P1** | Close listener registries **before** killing work, and await child exit (`defensive-patterns.md:21`) | `services/daemon_manager.py`, `workbench/pty_io.py` | Late completions from a dying tool must stay silent | M | Medium |
| 8.7 | **P1** | Windows-safe unlink for link-shaped paths (`defensive-patterns.md:31-33`) | `services/sandbox/paths.py`, `workbench/worktree_service.py`, `shadow_git.py` | `rmSync` on a junction can delete into the target; August ships worktrees and shadow git | S | **High** — data loss if wrong |
| 8.8 | **P2** | Scrubbed env for spawned commands; private 0700 dirs + random names + `'wx'` opens (`defensive-patterns.md:27-29`) | `services/sandbox/runner.py`, `services/host_agent.py` | Credential-leak prevention for untrusted output | M | Medium |
| 8.9 | **P2** | Refuse-to-read on an unsupported session format, distinct from corruption (`persistence.md:187-189`) | `workbench/sessions.py`, `lib/migrations.py` | Fail loudly rather than replaying half-understood history | M | Low |

---

## 9. Testing & robustness

### 9.1 Test tiers (`docs/testing.md`)

| Tier | Command | What it gates |
|---|---|---|
| Unit | `pnpm run test` | vitest, colocated; **every registry gets an HMR-safety test**; prefer edge cases, error paths, event ordering, concurrency races (`:9`) |
| Coverage | `pnpm run test:coverage` | **per-file 100% on `packages/*/*/src`** (`:10`) |
| Real-API e2e | `pnpm run test:e2e` | live provider keys, self-skipping (`:11`) |
| Expected output | `pnpm run test:expected` | keyless assembled CLI/process expectations (`:12`) |
| Benchmarks | `pnpm run test:bench` | required Linux PR gate; time, heap, scaling budgets (`:13`) |
| Snapshot | `pnpm run test:snapshot` | recorded-session replay (`:14`) |
| Web browser | `pnpm run test:web` | Chromium ARIA/screenshot comparison, WebKit for the model picker (`:15`) |

Four policy lines worth lifting verbatim:

- *"An uncovered line is often dead code the gate flags for deletion, not a missing test to bolt on"* (`:10`).
- *"Only the process is isolated: ports, predictable paths, external namespaces, and inherited children are not. Own each acquired resource through its teardown, and read a spec that passes only when it runs alone as a defect in the spec"* (`:21`).
- *"We are DeepSeek — do not ration real-API tests. A no-key test proves plumbing; only a with-key run proves the agent works against a real model"* (`:23`).
- *"Verify the world, not the self-report: an e2e assertion re-runs the command or re-reads the file externally; a keyword probe on the agent's own output lets a cheating agent pass"* (`:33-35`).

### 9.2 Snapshot strategy

A snapshot scenario's **highest recorded parent generation supplies user input and model replay, and serves as the expected persisted result** (`docs/testing.md:14`). Mutating scenarios additionally compare a complete `workspace.expected/` tree, *"which record and refresh never rewrite"* (`:14`). `snapshot.yml` declares the profile, composition class, recording policy, and workspace facts.

The benchmarks directory is performance-only: `session-open`, `active-stream-reconnect`, `long-session-browser`, `terminal-io`, `agent-continuation`, `conversation-fold`, `support`. The reconnect one is a good model — it measures the **production client fold** when a reconnect carries an unfinished 100,000-delta reasoning prefix, with separate median budgets for replacement time (50 ms, 63 ms ceiling) and retained heap (30 MiB) (`benchmarks/active-stream-reconnect/README.md`).

### 9.3 Atomic writes and idempotency

`packages/util/atomic-write/src/index.ts:1-9` is a complete, dependency-free primitive:

> *"`writeFileAtomic` writes a random-suffix sibling with exclusive create and the caller's permission bits, then renames it over the target, so readers observe either the old or the new complete content… `withFileLock` serializes cross-process writers of one file through a `wx`-created `<file>.lock` sibling, so a read-modify-write cycle can never resurrect a state another writer just replaced; readers stay lock-free because the rename commit is atomic."*

Three specifics: the `'wx'` open *"refuses to follow a symlink planted at the temp path"*; the fresh inode carries `mode` through the rename *"so replacing a wider-permission file narrows it without a chmod race"*; and Windows transient `EACCES`/`EBUSY`/`EPERM` renames are retried with bounded exponential backoff (20 ms → 200 ms, 8 attempts) (`:60-70`, `:16-19`).

### 9.4 Sequence and ordering guarantees

- Session `seq` is contiguous (`seq = log.length`), enforced by validation, not convention (`docs/subsystems/session.md:228`, `:751`).
- `Session.append` **enforces JSON-serializability at the source**, so a bad event never enters the log and `snapshotEvents()` always equals what a backend can persist (`:751`).
- A persistence handle guarantees *"once an `append` or `flush` resolves on a write handle, every read STARTED afterwards on the same backend instance — on any handle, or through `stat`/`list` — observes at least that prefix. Reads concurrent with a mutation carry no ordering promise beyond the valid contiguous prefix"* (`docs/subsystems/persistence.md:35-39`).
- The retry projection is idempotent under replay (`packages/llm/llm-retry/src/index.ts:135`).
- Message projections are validated **completely before commit** (`docs/subsystems/session.md:365`).

### 9.5 Postmortems as a durable artifact class

`docs/postmortem/` holds four numbered, permanent records (`0001-acp-default-export-drops-inject`, `0002-js-expression-disabled-filesystem-tools`, `0003-web-agent-gui-feedback-loop`, `0004-landlock-partial-notice-misclassified-child-failures`). Combined with `.agents/notes/{proposed,implemented,rejected,archived}/{architecture,bug-fix,feature,process,simplification,testing}/`, this is a genuine **decision-record discipline**: proposed decisions are written down *before* implementation, with the rejection path preserved (`.agents/notes/rejected/` is a first-class directory in the tree).

### Transferable to August — Area 9

| # | Priority | What DSH does | August files | Why it matters | Effort | Risk |
|---|---|---|---|---|---|---|
| 9.1 | **P0** | Atomic write = `'wx'` random-suffix sibling + rename, carrying `mode` through the inode, with bounded Windows rename retry (`atomic-write/src/index.ts:1-9`, `:60-70`) | `backend-py/app/atomic_write.py`, `app/lib/storage_key_migration.py` | August already has an atomic-write module; verify it uses `O_EXCL` + rename (not truncate-in-place) and handles Windows `EPERM` | S | Low |
| 9.2 | **P0** | Cross-process `withFileLock` sibling so read-modify-write cannot resurrect stale state (`atomic-write/src/index.ts:1-9`) | `atomic_write.py`, `services/memory_store/*` | Two August windows writing config/memory concurrently today can lose a write | M | Low |
| 9.3 | **P0** | Contiguous-`seq` + JSON-serializability enforced **at append time**, so a corrupt event never reaches the log (`session.md:228`, `:751`) | `workbench/sessions.py`, `services/event_log.py` | A single non-serializable payload corrupts the whole durable story | M | Medium |
| 9.4 | **P1** | Cross-handle freshness guarantee stated as a contract (`persistence.md:35-39`) | `workbench/durability.py`, `checkpoint_service.py` | Makes "I flushed, so a reader sees it" a documented guarantee rather than an accident | M | Low |
| 9.5 | **P1** | Idempotent replay of operational events (retry projection) (`llm-retry/index.ts:135`) | `workbench/sessions.py`, `services/logger.py` | Replaying a turn after a crash must not double-count a retry | S | Low |
| 9.6 | **P1** | Performance gates for the **production** fold, not a test double, with separate time and retained-heap budgets (`benchmarks/active-stream-reconnect/README.md`) | new `benchmarks/` + a CI job | A 100k-delta reconnect fold is exactly where a Tauri chat UI dies | M | Low |
| 9.7 | **P1** | Numbered postmortems + a `notes/rejected/` decision archive (`.agents/notes/`, `docs/postmortem/`) | `docs/research/`, `docs/decisions/` | Preserves the "we tried this and rejected it" knowledge August currently loses | S | Low |
| 9.8 | **P2** | "Verify the world, not the self-report" as a written testing law (`testing.md:33-35`) | `backend-py/tests/`, `npm run test:frontend` | Guards against an e2e that greps the agent's own output | S | Low |
| 9.9 | **P2** | HMR-safety test for every registry (`testing.md:9`) | `backend-py/tests/` | Registration/disposal leaks are the hardest class of harness bug | M | Low |

---

## Consolidated priority list

### P0 — do first

1. **Durable failed-attempt records** (`assistant/attempt` analogue) — 1.1
2. **Sticky `max-tokens` at turn level** — 1.2
3. **Drop truncated tool calls in the assembler** — 1.3
4. **Honest error results for tool calls skipped after abort** — 5.2
5. **Explicit allowlist for model-facing tool schema projection** — 5.3
6. **Monotonic guards with no allow result** — 5.1
7. **Typed `surfaceOp` replace + `contentGeneration`** — 3.1
8. **Crash repair before session publish** (`interrupted` closer) — 8.1
9. **Settlement notice for every returned subagent id** — 2.1
10. **Never report partial subagent output as success** — 2.2
11. **Optimistic revision + stored-state path edits for settings** — 7.1, 7.2
12. **Cross-process file lock for read-modify-write** — 9.2
13. **Reconnect-safe client stream fold with `rebaseline`** — 6.1
14. **Raw tool-argument prefix during streaming** — 6.2

### P1 — next

Turn-stopping re-read (1.4) · durable retry-before-wait (1.5) · retry budget in a projection (1.6) · subagent note source kind (2.4) · durable delegation depth (2.5) · pre-await permission capture (2.6) · spill-to-file for oversized results (3.4) · durable compaction lock (3.5) · overflow retry only on generation advance (3.6) · advisory repeat nudge (4.2) · interjection reset (4.3) · mode re-classification + model-ordered commit (5.4) · fail-closed concurrency (5.5) · approval `allowed-once` fail-closed (5.6) · stable UI node ids (6.4) · durable/transient start reconciliation (6.5) · coalescing shutdown (8.4) · orthogonal outcome reporting (8.5) · listener-close-before-kill (8.6) · junction-safe unlink (8.7) · append-time JSON validation (9.3) · perf gate on the production fold (9.6).

### P2 — later

Runtime "model-visible means logged" invariant (1.7) · explicit budget objects (1.8) · subagent capability preflight (2.8) · interrupt preservation semantics (2.9) · session-corpus full-text search (3.7) · code-point pruning (3.8) · display-vs-detection cap split (4.4) · typed tool render-intent cards (5.8) · scoped tool filter (5.9) · rebaseline on index mismatch (6.7) · native config document editor (7.6) · layered patch config model (7.7) · env scrubbing + private temp dirs (8.8) · refuse-unsupported-format (8.9) · world-verification testing law (9.8) · HMR-safety tests (9.9).

---

## Do not copy / traps

1. **Do not copy the Cordis plugin runtime.** `docs/architecture.md:11-13` — *"There is no privileged core to patch."* Adopting a full DI/plugin tree in a FastAPI + React codebase is a multi-quarter rewrite with no incremental payoff. August's service-module layout already achieves the same testability. The *transferable* part is the seam **contract** (Service Definition / Provider / Consumer, `docs/architecture.md:131-133`), not the framework.

2. **Do not adopt the "no round cap" default.** DSH's loop has no step/round cap at all (`packages/core/agent-loop/src/index.ts:334-335` is the only loop budget). That works because DSH's loop is bounded by a *different* mechanism (model stops, `concludesTurn`, goals). August's uncapped `MAX_MANAGED_TOOL_ROUNDS = 0` is a deliberate product choice backed by a stall detector; replacing it with DSH's approach would delete the stall detector without adding a bound.

3. **Do not adopt the 100% per-file coverage gate as-is** (`docs/testing.md:10`) without accepting its hidden cost. It is paired with a "delete dead code" policy. August's 626 Python + 629 TS files would need either mass deletion or a large test-authoring effort. The *principle* ("an uncovered line is often dead code") is worth adopting in review; the gate is not, yet.

4. **Do not copy the multi-name, multi-provider subagent seam wholesale.** DSH supports `spawn`, `fork`, `acp`, `codex`, `claude-code`, `dsh-sdk` (`docs/subsystems/subagent.md:5-7`). August's in-process orchestrator covers the equivalent of `spawn`/`fork`. Copying the full registry means shipping and maintaining transports to third-party CLIs — a product surface decision, not an architecture one.

5. **Do not add an LLM reviewer/verifier.** `packages/experimental/auto-review/src/index.ts` is a ~1,500-character prompt-as-policy gate. August's verifier gate was removed by explicit user request. Do not re-add it in DSH's shape.

6. **Do not copy the "replace malformed JSON" assumption.** DSH deliberately preserves unparseable tool arguments as text and lets the validator reject them (`packages/core/agent-loop/src/tool-calls.ts:104-111`). August's `json_salvage.py` patches the JSON instead. DSH's behaviour is the safer default, but salvaging is not automatically wrong — it is simply a deliberate divergence that needs its own tests, not a thing to "fix" from this report.

7. **Do not treat the surface-replacement `startSeq`/`endSeq` pair as a numeric range.** `docs/subsystems/compaction.md:59-70` — after a replacement lands a fresh high-seq summary node at an older range's position, `start` can be **greater than** `end`. Any adoption of `surfaceOp` must carry `shadowedSeqs` as the authoritative set.

8. **Do not build long-term memory from this report.** DSH ships none (`docs/user/guide/mcp-memory.md:31`). August's Brain, `remember`/`list_facts`, BM25 tail, and frozen-boot-index policy are strictly more advanced. This report's Area 3 is about *context management*, not memory.

9. **Watch the Windows rename trap.** August is a Windows-primary Tauri app. `packages/util/atomic-write/src/index.ts:16-19` exists because atomic rename transiently fails with `EACCES`/`EBUSY`/`EPERM` on Windows. A naive `os.replace` in `atomic_write.py` can leave a half-written settings file.

10. **Watch the junction trap.** `docs/defensive-patterns.md:31-33` — on Windows, `rmSync`/`shutil.rmtree` on a junction throws `ERR_FS_EISDIR` and recursive deletion can descend *through* the junction into its target. August ships `worktree_service.py` and `shadow_git.py`; both must lstat-then-unlink link-shaped paths.

11. **Do not copy `reasoning-delta` into the derived model history as a first-class durable message without deciding your retention policy.** `docs/subsystems/session-query.md:145` — search text deliberately *excludes* reasoning blocks. DSH stores reasoning in the stream but not in searchable semantics. Copying the block type without the exclusion rule would put chain-of-thought into August's search index.

12. **Do not copy the approval-request argument omission blindly.** `docs/subsystems/approval.md:69-80` omits arguments because the tool call is *already streamed and addressable by `callId`*. If August's approval card can be opened for a tool call whose arguments are not on screen (e.g. from a history page), the omission becomes a data loss, not a de-duplication.

13. **The `agent/turn-stopping` re-read pattern is worth copying; the "listener can steer" API is not, by itself.** Adopting the re-read requires August's `update_state` self-heal to route its nudge through the same inbox, otherwise the re-read is a no-op. The two halves must land together (that is why it is 1.4, effort M).
