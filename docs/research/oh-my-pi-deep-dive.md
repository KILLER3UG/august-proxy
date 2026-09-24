# oh-my-pi — architecture deep dive for August Proxy

**Repo studied:** `https://github.com/can1357/oh-my-pi.git` — the real repo, no redirect, no rename. The package it actually ships is `@oh-my-pi/pi-coding-agent` (a fork of `pi-mono`), and the repo root is a Bun/TypeScript monorepo plus ~80k lines of Rust native crates.
**Commit:** `1369afed74369c24a31e2dbe8a0dfa011308c04a` — *"Merge pull request #13000 from DarkPhilosophy/fix/devin-fusion-lead"*, 2026-09-24.
**Local clone:** `C:/Users/rober/AppData/Local/Temp/ref-repos/oh-my-pi`

Every claim below is cited as `path:line` relative to that clone root. August file paths are relative to `C:/Dev/august-proxy`.

Size context that matters for the transfer decisions: `packages/agent/src/agent-loop.ts` is 3,713 lines; `packages/coding-agent/src/session/agent-session.ts` is 11,674 lines; `packages/coding-agent/src/config/settings-schema.ts` is 6,390 lines. This is a system that has grown organically for a long time, and several of its best ideas are *narrow* (a guard, a flag, a recovery branch) sitting inside very large files. Copying the idea, not the file shape, is the point.

---

## 1. Agent loop / harness

### 1.1 Turn structure

The loop is `runLoopBody` in `packages/agent/src/agent-loop.ts:1153-1734`. It is a **two-level** structure that August's single flat `while` does not have:

- **Outer loop** (`agent-loop.ts:1261`, `while (true)`) — "continues when queued follow-up messages arrive after agent would stop."
- **Inner loop** (`agent-loop.ts:1265`, `while (hasMoreToolCalls || pendingMessages.length > 0)`) — processes one model call plus its tool batch, folds in steering/asides at the boundary.

Three separate message queues feed the boundary, and the distinction matters (`agent-loop.ts:1680-1690`, `:1709-1715`):

| Queue | Drained where | Rule |
|---|---|---|
| `steering` | inner-loop boundary, every iteration | live user input; forces another turn |
| `aside` | mid-work folded into `pendingMessages`; at a stop boundary deferred to the outer drain | passive; must **not** trigger an extra model turn on its own |
| `followUp` | outer drain only | queued work after the agent would stop |

The key comment is at `agent-loop.ts:1686-1688`: *"At the stop boundary: only steering (live user input) forces another turn here. Leave asides for the outer drain below so a passive aside can't trigger an extra model turn ahead of a queued follow-up."* August collapses this into one `pendingMessages` array and will happily start a turn for a diagnostic block.

**Aside discard is a first-class contract, not a GC concern.** `resolveAsides` (`agent-loop.ts:1128-1141`) resolves an entry as either a ready message or a **sync thunk** evaluated at the moment of injection, so a producer can make the final inject-or-drop decision against up-to-date state. Anything unresolved at loop exit is explicitly discarded through a hook (`agent-loop.ts:1723-1724`):

```ts
} finally {
    discardAsides(pendingMessages, new Error("Aside message was not committed before the agent loop ended"));
```

### 1.2 Paired turn boundaries and the abort invariant

Every turn emits `turn_start` / `turn_end` symmetrically. `emitTurnEnd` (`agent-loop.ts:734`) fires at every exit including the error paths, and the loop tracks `turnOpen` so a gate that fires *before* the turn opened still opens one and closes it (`agent-loop.ts:1330-1372`). August's `turn_end` (`backend-py/app/services/workbench/workbench.py:5591`) is emitted once at the end and is **not** guaranteed on the exception paths that matter most.

### 1.3 Tool-call pairing — the single most important invariant

Providers require every `tool_use` to be followed by a matching `tool_result`. oh-my-pi enforces this in **four** distinct places, and August currently enforces it in roughly one.

1. **Provider errored/aborted mid-turn with tool calls present** (`agent-loop.ts:1471-1513`): every emitted `toolCall` gets a synthetic aborted result pushed into both `currentContext.messages` and `newMessages`.
2. **Non-runnable stop (`length` truncation, deadline passed) with tool calls present** (`agent-loop.ts:1615-1639`): placeholder results, reason `length` / `aborted` / `skipped`, then `hasMoreToolCalls = true` so the turn continues.
3. **Batch interrupted mid-flight** — the tail sweep after `Promise.allSettled` (`agent-loop.ts:3494-3504`) guarantees every record that produced no `toolResultMessage` gets exactly one skipped result. The comment at `:3136-3139` is explicit that this tail sweep is the *single* path for orphan records, so skip decisions elsewhere must not double-count.
4. **Resume tail** (`agent-loop.ts:1222-1258`, via `unpairedToolCallTail` at `:642`): a session restored with a trailing assistant message whose tool results were stripped re-executes those calls *before the first model call*, so side effects are not lost and the pairing invariant is restored.

Synthetic results are tagged so downstream consumers can distinguish "call emitted, not executed" from "tool failed" (`agent-loop.ts:3526-3545`):

```ts
 * The synthetic result exists only to preserve the tool_use / tool_result
 * pairing the provider API requires; no `tool.execute()` ran. UI, telemetry,
 * and history consumers can key on `__synthetic === true`
```

This is a trap for August: its `_truncateToolOutput` returns `(trimmed, truncated)` and the SSE path and the history path both truncate independently (`workbench.py:5237`, `:5348`). The two truncations can disagree, which is the same class of bug.

### 1.4 Which stops continue the turn

`agent-loop.ts:1515-1539` carries one of the best comments in the codebase:

```ts
// Run tools whenever the turn carries tool_use blocks AND was not truncated.
// `stop_reason` is provider metadata that never goes back on the wire, so it
// does not gate continuation validity ... So treat `stop` (end_turn/pause_turn)
// the same as `toolUse`. `length` (max_tokens) is the one reason we must NOT
// run: the trailing tool_use may be truncated with incomplete arguments
```

```ts
const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
hasMoreToolCalls = runnableStop && toolCalls.length > 0;
```

Only `length` refuses to execute, because the arguments may be half-written. August should adopt this exact rule: **`length` is the only stop reason that must not dispatch tools.**

### 1.5 Caps, budgets, and every guard on the loop

| Guard | Value | Location | Purpose |
|---|---|---|---|
| `MAX_PAUSED_TURN_CONTINUATIONS` | 8 | `agent-loop.ts:112` | provider keeps returning `pause_turn` without a tool call — re-sampling is a full request each time, so it must not spin |
| `MAX_SOFT_TOOL_ESCALATIONS` | 3 | `agent-loop.ts:120` | a forced `toolChoice` guarantees the call; this is purely defensive |
| `STEERING_INTERRUPT_POLL_MS` | 250 | `agent-loop.ts:176` | cadence for polling steering while an interruptible tool is in flight |
| `config.deadline` | wall clock | `agent-loop.ts:1166-1178` | converted to an `AbortSignal` merged with the external signal via `AbortSignal.any` |
| `SOFT_REQUEST_BUDGET` | scout 100, sonic 100, default 200 | `task/executor.ts:125-131` | per-subagent request ceiling |
| `MAX_YIELD_RETRIES` | 3 | `task/executor.ts:2084` | reminder ladder before a subagent is driven to a forced final `yield` |
| `MAX_OUTPUT_BYTES` / `MAX_OUTPUT_LINES` | 500_000 / 5000 | `task/types.ts:24-30` | per-subagent output caps, env-overridable |

The soft-tool-requirement mechanism (`agent-loop.ts:1546-1591`) is worth calling out because it has no August analogue at all. When the host declares a *soft* requirement ("you must call `update_state` before finishing"), the loop:

- injects reminder messages when the requirement id changes (`:1308-1318`),
- if the turn calls only the wrong tool, **discards** the speculative work, pairs each call with a `skipped` result, and forces the required tool next turn (`:1560-1591`),
- never executes detour tools while the requirement is pending — *"A required+detour batch is treated as non-compliant so detour tools never run side effects while the requirement is still pending."*

August's `update_state(phase=…)` is exactly this requirement, but today it is a *nudge* (a self-heal reminder after 8 stalled rounds) rather than a gate.

### 1.6 Malformed output recovery

Four distinct recovery mechanisms, each with a narrow trigger:

**(a) Transient stream error with a complete tool turn** — `recoverTransientErrorToolTurn` (`agent-loop.ts:2447-2492`) rewrites `stopReason: "error"` to `"toolUse"` when every emitted tool call names an available tool *and* the error text is a stream-read / envelope / transient-parse error. Refusals and sensitive-stop are explicitly excluded (`:2456-2462`).

**(b) Incomplete tool calls after a stream error** — `retainCompletedToolCalls` (`agent-loop.ts:2420-2445`) drops tool-call blocks that never completed, and stamps the message with `stopDetails.type = "stream_interrupted_after_content"`. The dropped calls then get aborted placeholders on the normal path.

**(c) GPT-5 Harmony protocol leakage** — `HarmonyLeakInterruption` (`agent-loop.ts:178-187`). Two separate counters (`harmonyRetryAttempt` capped at 2, `harmonyTruncateResumeCount` capped at 2) gate two different recoveries: abort-and-retry, or truncate-and-resume (`:1426-1453`). Every recovery is audited through `onHarmonyLeak` before the retry (`:1736-1751`). This is the most sophisticated malformed-output handler in the repo and it is provider-specific.

**(d) Malformed tool results** — `coerceToolResult` (`agent-loop.ts:521-592`) is the *choke point* every tool result passes through, including the `afterToolCall` post-hook (`:3313-3321`) and the speculative path (`:3228`). It:

- rejects a non-array `content` outright with a readable message,
- drops individual malformed blocks and **appends a counted notice** (`"3 content blocks had an unsupported shape"`),
- `sanitizeText()`s every text block (`:567`),
- forces a non-empty body when `isError` is set, because *"Anthropic rejects tool_result blocks with is_error: true and empty content"* (`:577-581`),
- never lets `useless` coexist with `isError` — *"Errors are never useless"* (`:536`).

August has `json_salvage.py` for *arguments* and nothing equivalent for *results*. A tool that returns `{"content": "oops"}` in August will be persisted verbatim.

### 1.7 Non-compaction retry

`docs/non-compaction-retry-policy.md` is the spec; `session/turn-recovery.ts` (2,876 lines) is the implementation.

**Classification** (`turn-recovery.ts:1291-1321`):

```ts
isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error") return false;
    if (this.#isUsagePreflightBlocked(message)) return false;
    if (AIError.isResponsesRequestBodyReadTimeout(message)) return false;
    ...
    // Context overflow is handled by compaction, not retry.
    if (AIError.isContextOverflow(message, contextWindow)) return false;
```

The sophisticated part is the **replay-safety veto** (`:1312-1321`). Retrying a turn that already emitted visible text would duplicate whatever the model already committed. So:

```ts
if (this.#hasReplayUnsafeOutput(message) && !replaySafeUnexecutedTools) return false;
```

with a narrow exception carved out at `:1330-1360` (`#unexecutedToolCallsReplaySafe`): if every emitted tool call has a *synthetic* result saying `executed === false`, the turn proves nothing ran, so replay is allowed. The comment is explicit: *"Any uncertainty keeps the replay veto in place."*

**Backoff** (`docs/non-compaction-retry-policy.md:78`, `:114-124`): `min(baseDelayMs * 2^(attempt-1), 8000ms) * (75–100% jitter)`, defaults `enabled=true, maxRetries=10, baseDelayMs=500, maxDelayMs=300000`. Credential/model switches set delay to 0.

**Error taxonomy** is a bitmask, not a string enum (`packages/ai/src/error/flags.ts:20-46`): `Transient`, `Timeout`, `UsageLimit`, `StaleResponsesItem`, `MalformedFunctionCall`, `ProviderFinishError`, `EmptyResponse`, `ContentBlocked`, `AccountPolicy`, `ContextOverflow`, `AuthFailed`, `SilentAbort`, `UserInterrupt`, `Abort`, `Grammar`, `FastModeUnsupported`, `OAuthExpiry`, `PayloadRejected`. `retriable()` (`flags.ts:374-380`) refuses `ContentBlocked` and `PayloadRejected` unconditionally and refuses everything when `replayUnsafe` is set.

August's eight-family taxonomy is named in `AGENTS.md` and is a reasonable sibling of this; the bitmask's advantage is that a *single* error can carry several facts (e.g. `Transient | Timeout | AuthFailed`) and the predicates compose. August's strings cannot.

### 1.8 Context-window management

Two mechanisms, both in `packages/agent/src/`:

**(a) Output-cap fitting** — `output-budget.ts:48-66`, `fitOutputTokensToContextWindow`. The rationale at `:20-33` is the money quote: *"Chat Completions-style providers reject a request whose prompt tokens plus `max_tokens` exceed the window. Every request asks for `model.maxTokens` of output by default, so without this a large model output cap makes every request fail once the prompt passes window minus output cap, long before compaction triggers."* The local count is padded by 10% to absorb tokenizer disagreement (`PROMPT_ESTIMATE_MARGIN_DIVISOR`, `output-budget.ts:15`), and the floor is `MIN_FITTED_OUTPUT_TOKENS = 1024` so a nearly-full window stops on `length` instead of 400-ing.

**(b) Stable prefix / append-only context** — `append-only-context.ts:1-16`. The system prompt and tool specs are computed once and frozen; messages only grow, so each turn's cache miss is exactly the new user delta. `prepareProviderCall` (`agent-loop.ts:1760-1810`) routes through it when configured, and records the exact wire tool definitions it sent (`agent-loop.ts:1806-1810` → `sent-tool-definitions.ts`) so a provider that keeps withdrawn tools declared (Anthropic `tool_removal`) can re-declare them byte-identically.

**Framing-token memoization** — `output-budget.ts:74-108` caches the token count of `systemPrompt` / `tools` / `inactiveTools` in a `WeakMap` keyed on the array, invalidated by length. This is the difference between re-tokenizing 30 tool schemas every turn and not.

### 1.9 Streaming

`streamAssistantResponse` (`agent-loop.ts:1819-2419`). Structural choices worth naming:

- **One abort race for the whole stream** (`agent-loop.ts:2014-2028`): a single `Promise.withResolvers` + `once` listener reused for every `iterator.next()`, instead of allocating a new race per event. The comment says exactly why.
- **Incremental snapshot rebuild** with `openBlocks: Set<number>` (`agent-loop.ts:1966`) for blocks that started streaming but have not ended, *"re-cloned on every delta because live blocks may be patched without a paired event."*
- **Per-call argument streams** (`argStreams: Map<number, AgentToolArgStream>`, `agent-loop.ts:1968`) with a `cancelArgStreams` path (`:1969-1978`) that logs and continues on a throwing cancel.
- **Finalized message mutations happen once, before all consumers** (`agent-loop.ts:2070-2076`): `transformAssistantMessage` runs *before* the message reaches context, UI, or tool dispatch, so a single mutation is the source of truth for all three.
- **Pre-dispatch hook runs only when the turn can actually dispatch** (`agent-loop.ts:2081-2089`): `finalToolCallsCanDispatch` is computed from the abort state and the callback before `prepareToolCallDispatch` is invoked, which keeps host-deferred speculation from being released for truncated turns.

---

## 2. Subagents / delegation

### 2.1 Where the code lives

- `task/executor.ts` (4,321 lines) — in-process execution
- `task/structured-subagent.ts` (808) — shared policy resolution for `task` and `eval`
- `task/isolation-runner.ts` (799), `task/worktree.ts` (1,067) — workspace isolation
- `task/workpool.ts` (663) — keep-alive agent pool with a work queue
- `task/output-manager.ts` (119) — id allocation
- `task/result-summary.ts` (85) — the `<task-result>` envelope
- `task/provider-concurrency.ts` (100) — per-provider LLM semaphore
- `task/isolation-ownership.ts` (167) — sandbox liveness

### 2.2 The yield contract

A subagent does not "return" — it **yields**. The child has a `yield` tool; the parent receives a typed object. `driveSessionToYield` (`task/executor.ts:2093-2228`) runs a reminder ladder:

```ts
while (!monitor.yieldCalled() && retryCount < MAX_YIELD_RETRIES && !abortSignal.aborted) {
```

Three details make this robust:

1. **It skips reminders on a terminal error** (`executor.ts:2184-2185`): *"Re-prompting would just hit the same wall, multiplying the failure noise without any chance of producing a yield."*
2. **The final retry is a forced `toolChoice`** (`executor.ts:2194-2206`): `toolChoice: buildNamedToolChoice("yield", session.model)` — *"Last chance: the next accepted yield ends the run, incremental or not, so the pinned model cannot answer the pin forever."*
3. **A budget stop collapses the whole ladder into one forced yield** (`executor.ts:2174-2179`), so partial findings come back as a real report instead of being hard-aborted.

A subagent that exits *without* yielding gets a named warning and, if a schema was in play, a non-zero exit (`executor.ts:663-665`):

```ts
export const SUBAGENT_WARNING_MISSING_YIELD =
    "SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";
```

### 2.3 Schema validation and the strict/permissive split

`finalizeSubprocessOutput` (`task/executor.ts:692-839`) is a complete output-normalization state machine:

- yield with `status: "aborted"` → synthetic `{"aborted": true, error}` output, exit 0 (`:705-713`);
- null yield data → `SUBAGENT_WARNING_NULL_YIELD`, and **in strict mode this becomes a non-zero exit**, not a warning-decorated success (`:721-734`);
- validated data → exit 0 with `structuredOutput.status = "valid"` (`:747-760`);
- failure in strict mode, or in permissive mode with no override, → `buildSchemaViolationOutcome` returns exit 1 (`:761-767`);
- no yield at all → if a schema was declared *or* output was empty, exit 1 (`:828-835`).

There is also a **fallback completion path** (`executor.ts:790-824`): if the child exited 0 with no yield but its stdout happens to be schema-valid JSON, that is accepted as the yield data. This is the difference between "structured output" and "structured output or the harness died quietly."

The warning strings themselves are exported constants (`executor.ts:661-665`) so the parent, the UI, and tests all key on the same text.

### 2.4 Output-loss prevention

This is the strongest subagent area in the repo.

**IDs never collide, even across resume** — `AgentOutputManager` (`task/output-manager.ts:24-119`). First allocation of a name is verbatim; repeats get `-2`, `-3` (`:84-92`). Two ids are *reserved up front*: the advisor transcript stem and the pinned-HUD toggle sentinel (`:37-43`), because a colliding id would clobber a file or become indistinguishable in click routing. On init the manager **scans the artifacts directory** and seeds the taken set (`:60-85`) so a resumed session never overwrites a prior subagent's output. Nested agents get a `parent.` prefix.

**Result envelope is a preview plus a pointer** — `formatTaskResultSummary` (`task/result-summary.ts:41-85`). Over `FULL_OUTPUT_THRESHOLD = 5000` chars the envelope inlines a line-boundary-safe head and points at `agent://<id>` (`:15`, `:31-38`). Empty output is annotated by request count (`:22-27`):

```ts
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
    const base = result.output.trim() || result.stderr.trim();
    if (base) return base;
    return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}
```

so the parent can distinguish a no-op child from one that burned 40 requests and was cancelled.

The envelope also reports **resumability** (`:64-66`): an aborted run is resumable only if it is *not* isolated and its registry status is idle/parked — *"Isolated runs are parked without a reviver (their worktree is gone), so their 'parked' status must not read as resumable."*

### 2.5 Concurrency and isolation

**Provider-level semaphore** — `task/provider-concurrency.ts:1-12`. The docstring names the exact deadlock it prevents:

```
 * The semaphore brackets only the streaming request itself, not the whole
 * agent lifetime: a parent subagent releases its slot the moment its LLM
 * stream finishes producing, so children spawned during tool execution can
 * acquire slots for their own turns. Holding the slot across the parent's
 * full conversation deadlocks any spawn tree whose width exceeds
 * `maxConcurrency`
```

**Spawn policy from frontmatter** — `task/spawn-policy.ts:22-59`. `spawns: "*" | false | "a,b,c"` resolves to `{enabled, defaultAgent, allowedAgents, allowedErrorText, allowedPromptText}`. The error text is generated from the same source as the prompt text, so the two can never drift.

**Recursion depth** — `canSpawnAtDepth` (`task/types.ts:172-174`): `maxRecursionDepth < 0` disables the cap.

**Isolation ownership with pid-recycling safety** — `task/isolation-ownership.ts:1-50`. The sandbox marker records `{pid, id, startToken}`, where `startToken` is boot-stable (Linux reads `/proc/<pid>/stat` field 22). The rationale (`:25-31`): *"Distinguishes the owning process from an unrelated process that later inherits a recycled pid, so a crashed sandbox is never pinned live."* Windows degrades to pid-only, documented at `:44-49`.

**Nested patches** — `persistNestedPatches` / `applyEligibleNestedPatches` (`task/isolation-runner.ts:215`, `:776`) collect a grandchild's diff and apply it at the parent's boundary, so a merge conflict never silently drops a sub-subagent's work.

---

## 3. Memory & context

### 3.1 Compaction is an entry, not a message

`docs/compaction.md:27-49`. Compaction is a `CompactionEntry` (and `BranchSummaryEntry`) in the session journal with a `firstKeptEntryId` boundary, `tokensBefore`, and optional `preserveData`. `buildSessionContext` then converts them back into user-context messages at rebuild time. The consequence: **branching a session that has been compacted is a pointer move, not a re-summarization**, and a `/tree` navigation to a pre-compaction branch recovers the original messages.

**The cut-point invariant** (`docs/compaction.md:251-259`): valid cut points are user/assistant/bashExecution/hookMessage/branchSummary/compactionSummary entries — and *"**Hard rule: never cut at `toolResult`.**"* A compaction that splits a `tool_use`/`tool_result` pair produces an invalid request on every later turn.

**Split-turn handling** (`docs/compaction.md:261-287`): if the cut is not at a user-turn start, compaction generates *two* summaries (history + turn prefix) and merges them with a `---` separator and a `**Turn Context (split turn):**` header.

**The three-region guarantee** (`docs/compaction.md:249`): *"When updating a local summary, every effective original message belongs to exactly one of those three regions."* `prepareCompaction` (`packages/agent/src/compaction/compaction.ts:1339`) builds one sequence used for estimation, cut-point selection, and all three regions, so the retained tail can never double-count or lose a message.

### 3.2 Six distinct triggers, four distinct paths

`docs/compaction.md:64-139`. The paths are deliberately different:

| Trigger | Detect | Model promotion | Handoff allowed | Retries turn |
|---|---|---|---|---|
| Overflow | `isContextOverflow` on same-model error | yes, first | **no** — *"its request would reuse the overflowing input"* | yes |
| Incomplete output | `stopReason === "length"` | yes, first | **yes** — input is still usable | yes |
| Threshold | adjusted tokens > `resolveThresholdTokens` | yes, first | yes | no (auto-continue prompt instead) |
| Mid-turn | same, at a safe tool-loop boundary | — | — | loop owns it |
| Idle | `runIdleCompaction()` | — | — | no |
| Manual `/compact` | user | — | — | resumes unless cancelled |

Overflow removing the failing assistant message before recovery (`:114-116`) matters: retrying with the poisoned message in context is a guaranteed second failure.

**Token accounting excludes non-replayed tokens** (`docs/compaction.md:129`): `calculateContextTokens` (`compaction/compaction.ts:270`) *"subtracts provider-side orchestration tokens (billable, but never replayed into the conversation prefix) so auto-compaction and context-promotion thresholds are not inflated by them."* August's `token_budget.py:201-201` `_flattenMessages` flattens everything into one string — it has no notion of the distinction.

### 3.3 Five compaction strategies with a walkable order

`compaction.methodOrder` defaults to `["remote", "snapcompact", "handoff", "shake", "soft"]` (`docs/compaction.md:491`). Each failure advances to the next preference, and *"Threshold, incomplete-output, and overflow recovery advance to the next configured method when shake cannot reclaim enough context to get below the recovery band; this prevents repeated no-op shake loops."*

Two of the five are **local, deterministic, and model-free**:

- **`shake`** (`packages/agent/src/compaction/shake.ts:316`): replaces eligible tool results and large fenced/XML blocks with `artifact://` references, with a protected recent-token window and a minimum-savings threshold. Three presets — `DEFAULT_SHAKE_CONFIG` (`shake.ts:46-51`: protect 16k tokens, min 4k savings, `skill` results and artifact-recovery reads protected), `AGGRESSIVE_SHAKE_CONFIG` for manual `/shake` (`:58-63`), and `RESCUE_SHAKE_CONFIG` for a compaction dead end (`:67-74`, `protectTokens: 0` so it can drop even the newest blocker).
- **`snapcompact`** (`docs/compaction.md:198-205`): serializes discarded history onto model-aware PNG frames using bundled pixel fonts, with the frame shape resolved from the *model id* and re-priced per provider's image billing. *"No model, API key, or network is involved, so snapcompact is also safe for overflow recovery."* The token-recall evaluation is in `packages/snapcompact`.

**Async (speculative) compaction** (`docs/compaction.md:492`): when context enters `[threshold − lead, threshold)` where `lead = clamp(threshold × 0.125, 8192, 32000)`, maintenance starts a background summarization off a branch snapshot. The armed result commits instantly when the threshold is actually crossed. It is discarded when the branch prefix changes, when a native payload becomes unreadable, or when context outgrows `keepRecentTokens` since compute. The status line pulses the icon while a speculation runs and holds it in accent when a result is armed.

### 3.4 Pre-compaction pruning with a token floor

`docs/compaction.md:213-236`. `pruneToolOutputs` (`compaction/pruning.ts:312`) protects the newest 40,000 tool-output tokens, requires ≥20,000 total estimated savings, and has a hard floor:

```ts
const MIN_PRUNE_TOKENS = 50;   // pruning.ts:123
```

with the reason spelled out (`docs/compaction.md:219`): *"the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing."* Skill results, `skill://` reads, and reads of the active plan reference file are never pruned.

**The `useless` flag** (`USELESS_NOTICE = "[Uneventful result elided]"`, `pruning.ts:70`) is the cheapest high-value idea in this whole section. A tool flags a finished result as contextually useless — zero search matches, a `wait` safety cap that returned only still-running work — and it is consumed in three places (`docs/compaction.md:228-236`): a per-turn stale pass, the threshold prune (bypassing the protect window), and summary serialization (dropping the whole call/result pair). The rules are tight: never together with `isError`, never removed from history (only blanked in place, preserving pairing), never on the wire, and *"Results smaller than the notice itself are never blanked (no savings)."*

### 3.5 Five memory backends behind one tool surface

`docs/memory.md:1-11`. `off | local | hindsight | mnemopi | sharpshooter`, selected by `memory.backend`, **off by default**. The local pipeline is two-phase (`docs/memory.md:74-86`): per-session extraction (role `default`) then cross-session consolidation (role `smol`) producing `MEMORY.md`, `memory_summary.md`, and `skills/<name>/`. Phase 2 uses a **lease and heartbeat** so multiple processes starting simultaneously cannot double-run.

The injection discipline is stated as instructions, not code (`docs/memory.md:26-28`):

> - Treat memory as heuristic context — useful for process and prior decisions, not authoritative on current repo state.
> - Cite the memory artifact path when memory changes the plan, and pair it with current-repo evidence before acting.
> - Prefer repo state and user instruction when they conflict with memory; treat conflicting memory as stale.

Memory is readable through `memory://` URLs from the same `read` tool (`docs/memory.md:32-44`), including the full `learned.md` and generated skills.

**Subagents never auto-recall or auto-retain** (`docs/memory.md:150`): they alias the parent's client/bank/scope for explicit `recall`/`retain`/`reflect` but run no background traffic. This is the right call and August already has it.

### 3.6 Display transcript ≠ LLM context

`docs/compaction.md:209`. The TUI renders `buildSessionContext({transcript: true})`: every path entry in chronological order, with each compaction shown inline as a slim divider `── 📷 compacted · ctrl+o ──`. Only the LLM context resets; the scrollback above the divider stays intact, including across resume. August's UI shows a compaction notice in-band (`state_blocks.py:123-158` `_compactionNotice`) but the transcript above it is not preserved as a distinct view.

---

## 4. Learning / self-improvement

### 4.1 Time-Traveling Stream Rules (TTSR) — the standout feature

`docs/ttsr-injection-lifecycle.md` is the full spec. The idea: **your rules sit dormant until the model goes off-script.** A regex (or ast-grep, or a judge question) match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point.

Trigger mechanics (`:116-124`):

```
1. Matched rules are deduplicated into the coordinator's pending injections.
2. The abort-pending flag is set and a TTSR resume gate is created.
3. `agent.abort()` is called immediately. For a tool match, the abort reason
   is scoped to that tool-call id so sibling calls receive the separate
   `TTSR interrupt on another tool call` reason.
4. `ttsr_triggered` is emitted asynchronously (fire-and-forget).
5. Retry work is scheduled ... with a 50ms delay, tagged with the current
   prompt generation and a retry token.
```

The **race guard** (`:128-130`, `:252-254`) is the part that makes it safe: after the 50ms the task verifies its retry token, prompt generation, abort-pending state, and target assistant message are all still current. Any failure clears pending state and resolves the gate without retrying.

`contextMode` (`:148-152`): `discard` removes the partial assistant output via `agent.replaceMessages(...slice(0, targetAssistantIndex))`; `keep` leaves it and appends the reminder after.

Non-interrupting paths are split by source (`:153-176`): a *tool-source* match gets a `<system-reminder>` **prepended to the matched tool's result content** via the `afterToolCall` hook — no abort, no extra turn; a *prose-source* match queues a hidden custom message with `agent.followUp()`. The doc states the consequence for tool authors (`:170-174`): *"Renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"`."*

**Repeat policy** (`:177-191`): `once` or `after-gap`, where the gap is measured in *completed turns* (`messageCount` increments on `turn_end`, not on stream chunks), default 10.

**Judge rules** (`:272-289`): a rule with a `question` is judged *after* the output completes, never mid-stream. One judge request per output carries every candidate's question over a shared state, content cut to 32,000 Jev tokens counted locally. A yes-probability ≥ 0.7 flags the rule; `claim()` ensures one rule flagged by several outputs is delivered once. Verdicts arriving after a session replacement are dropped. The session's `onBeforeYield` awaits in-flight judgments (up to 5s) so a warning about the final reply lands in the same run.

### 4.2 The advisor model

`docs/advisor-watchdog.md`. A second model with its own `Agent` instance and its own `ToolSession` (id suffixed `-advisor`), reading **only the new transcript delta** since its last update (`:90`). Provider-bound messages and tool arguments pass through the session secret obfuscator before reaching the advisor.

The recursion guard (`:94`): *"Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice."* And the reset list (`:96-103`): compaction, session switch/resume, branch/fork history replacement, and context-maintenance re-prime all reset the advisor's private transcript and rewind its cursor, so the next update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

**Severity semantics** (`:123-127`): `nit` → non-interrupting aside batched at the next step boundary; `concern` → interrupting steering; `blocker` → interrupting steering that still fires against a terminal answer. A deliberately interrupted primary does **not** auto-resume for advisor advice (`:137`) — an in-flight `concern` is preserved as a visible card instead of driving a surprise resume.

August removed its verifier in 2026-08-24 per `AGENTS.md`. **The advisor is a different mechanism from a verifier**: it is advisory, severity-graded, non-blocking by default, scoped to deltas, and explicitly unable to withhold an answer. That distinction is why it is worth reconsidering here.

### 4.3 `learn` — durable lessons and managed skills

`tools/learn.ts:10-19`. One tool that persists a lesson to long-term memory *and*, given a `skill` payload, mints or enhances a managed `SKILL.md` via a shared `writeManagedSkill` primitive. Approval is dynamic (`:32-34`): `write` if a skill is being minted or the backend is `local`, else `read`. Construction is gated on `autolearn.enabled` **and** a live backend (`:44-50`).

Failure is loud (`:60-65`): *"A failed write throws (closed DB / disk error). Fail loudly with the cause rather than reporting (and minting a skill for) a lesson that was never stored."*

Lesson bounds (`docs/memory.md:68`): content ≤ 2,000 chars, context ≤ 400, `learned.md` capped at 100 entries newest-first, deduplicated, secret-redacted — and *"a `learn` call does not mutate the active session's prompt-cache prefix."*

### 4.4 Prompt/model policy lives in data, not code

`AGENTS.md`, "Model/Provider Policy Lives in KDL": *"**NEVER hard-code model- or provider-conditional policy in TypeScript.** No `id.includes("claude")`, no model-name regexes, no per-model lookup tables (effort ladders, pricing, context windows, modalities, API routing, quirk flags)."* Everything is a `.kdl` rule under `packages/catalog/src/compat/rules/` compiled to a committed `rules.json` by `bun run gen:compat`. TS may branch only on structured facts from `classifyModel()`. Equal-rank overlaps throw `AmbiguousOverlapError` at resolve time.

August has the opposite convention: `cost_estimator.price_for_model` resolves env → model price → free flag → family table → default, and `AGENTS.md` explicitly forbids adding a second rate table. The oh-my-pi version is the same *idea* applied one level up — the family table moves out of Python into a compiled rule file with an ambiguity check.

### 4.5 Prewalk — a one-shot model handoff

`docs/prewalk.md`. An armed prewalk injects a planning nudge; the *first* successful `todo` call opens the gate; the switch to the `@smol` model happens after the first completed `edit` or `write`. The switch is one-shot. Read-only `xd://` device calls routed through `write` deliberately do **not** count — only workspace writes or execution. This is a genuinely novel cost optimization: pay the frontier model for reconnaissance and planning, pay the cheap model for the typing.

### 4.6 Review as a ranked verdict

`README.md` feature 10: `/review` spawns dedicated reviewer subagents in parallel, producing issues ranked **P0–P3 with a confidence score**, and `/annotate code-review` lets the user pin notes to diff lines before the reviewers run. August's `code_review.py` + `background_review_service.py` exist; the P0–P3 + confidence + pre-annotation loop is the transferable part.

---

## 5. Tool system

### 5.1 Tool definition surface

`AgentTool` (`packages/agent/src/types.ts:1059-1100`) carries several fields August has no concept of:

| Field | Meaning | Line |
|---|---|---|
| `loadMode` | `"essential"` = top-level schema; `"discoverable"` = moved behind `xd://` or BM25 tool search, **schema kept off every request** | `types.ts:976-985` |
| `concurrency` | `"shared" | "exclusive" | (args) => …` — resolved *per call* from the prepared (hook-revised) args | `types.ts:1083-1085` |
| `approval` | bare tier or object with `reason`/`override`/`policy`, **or a function of args** | `types.ts:996-1008` |
| `speculation` | declares the bounded, validated effect of a finalized call that may execute before dispatch commits | `types.ts:1088` |
| `openArgStream` | live receiver for a tool call's streamed arguments | `types.ts:1060-1063` |
| `docTopics()` | on-demand documentation readable as `xd://<tool>/<topic>` | `types.ts:1080-1082` |
| `lenientArgValidation` | validation errors non-fatal; raw args passed to `execute` | `types.ts:1091` |
| `intent` | a model-supplied "why" field, `require`/`optional`/`omit`, injected into the schema | `types.ts:989-1007` |

**Capability filtering is a routing decision, not a visibility toggle.** `loadMode` (`:976-985`): *"Selection (settings, `hidden`, `defaultInactive`, explicit `--tools`, provider availability) decides whether a tool is enabled; `loadMode` only decides how an enabled tool is presented."* August's `toolSurface` (`full`/`reduced`/`bare`) + `maxTools` (`workbench.py:1938-1940`) is the same idea in one dimension; oh-my-pi has two (`loadMode`) plus a third (arg-streaming disclosure).

`ESSENTIAL_BUILTIN_TOOL_NAMES` (`tools/essential-tools.ts:21-35`) pins 14 names that must stay top-level, and `defaultLoadModeForToolName` (`:41-44`) means **a UI-only re-register can never demote them** — the exact regression that issue #5764 was.

**Schema pruning** — `normalizeTools` (`agent-loop.ts:989-1015`). When the full catalog is rendered into the system prompt, tool specs ship **without descriptions** (top-level and nested annotations) so nothing is duplicated on the wire; the memoized `stripSchemaDescriptions` result is reused across requests.

### 5.2 Scheduling

`executeToolCalls` (`agent-loop.ts:2902-3524`) implements a **two-lane scheduler** (`:3456-3482`):

```ts
const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
const task = start.then(() => runTool(record, index));
tasks.push(task);
if (concurrency === "exclusive") {
    lastExclusive = task;
    sharedTasks = [];
} else {
    sharedTasks.push(task);
}
```

An `exclusive` tool waits for every shared task *and* the previous exclusive, then becomes the new barrier. Resolution happens on `record.args` — the hook-revised args — with a throwing resolver falling back to `"exclusive"` (safe) (`:3460-3472`). `bash` uses exactly this: PTY calls are exclusive, plain calls are shared (`tools/bash.ts:574-575`).

Result emission is **ordered, not completion-ordered** (`:3152-3162`): a validation failure is recorded in the prepare phase but *emitted at the record's scheduled slot* so batch order is preserved. The tail sweep (`:3494-3504`) is the single orphan path.

### 5.3 Interrupt policy — three tiers, not one

`agent-loop.ts:2935-2956`. This is a genuinely subtle design:

```ts
// `interruptMode: "wait"` only spares side-effecting work: interruptible
// waits are always cut short ...
const softInterrupts = interruptMode !== "wait";
```

- **Interruptible tools** (pure waits: `wait`, `vibe`) get `AbortSignal.any([external, steering, irc])` — queued steering cuts them short (`:2953-2955`).
- **Every other tool** gets *only* the external signal: *"neither queued steering nor a peer IRC ever hard-kills a partially side-effecting foreground tool (e.g. `bash`) — those get the cooperative `steeringSignal` above, and the message injects at the next boundary"* (`:2947-2951`).
- A **cooperative** signal rides `ctx.steeringSignal`; tools MAY react (auto-backgrounding bash) and ignoring it is always safe (`:2941-2946`).

The `runTool` preamble (`:3122-3142`) states the skip rule and its cost: non-interruptible work is *never* skipped because *"the expensive part — generating the call — is already paid, the tool itself is cheap, and a skip only makes the model re-emit the same call after the steer lands (#10439)."*

A 250 ms poll timer (`:3449-3455`) covers session-owned queues with no wake callback; an event-driven path is used when the host provides `waitForSteeringMessages` (`:3398-3445`), and it subscribes *before* checking queue state to close the edge race (`:3418-3421`).

The final guard (`:3380`) is a lesson: `await checkSteering().catch(() => undefined)` — *"An unguarded rejection here fires after the tool already ran and poisons the `start.then(runTool)` ordering chain, skipping every later chained record with a phantom 'pending steering' result."*

### 5.4 Passive tool context

`packages/agent/src/tool-context.ts`. A symbol-keyed carrier (`TOOL_RESULT_ADDITIONAL_CONTEXT`) that never serializes, so a tool can attach trusted agent-authored instructions to the next request without risking leakage into the persisted result (`:4-10`). The loop joins them and emits them as a developer message *after* the results they belong to (`agent-loop.ts:1107-1119`, `:3512-3519`). Ordering is specified: tool-reported context (including nested `xd://` dispatch) precedes hook context.

### 5.5 Truncation, artifacts, and the recovery guarantee

Three layers, all in `packages/tui/src/tools/streaming-output.ts`:

1. **Line/byte caps** — `DEFAULT_MAX_LINES = 3000` (`:10`), `DEFAULT_MAX_BYTES = 50 * 1024` (`:12`), `DEFAULT_MAX_COLUMN = 512` (`:14`).
2. **Final-defense inline cap** — `enforceInlineByteCap` (`:697-709`): 60% head, 25% tail, cut on line boundaries, never splitting a UTF-8 sequence, with ~15% slack for the marker and the artifact footer. The split is *not* 50/50 and the comment says why the tail matters (August's `_truncateToolOutput` docstring at `workbench.py:670-681` reaches the same conclusion independently: *"the tail carries final results (test summaries, exit codes, last error) that a head-only cut discards"*).
3. **Artifact spill** — the full text is written to `session/artifacts.ts` and referenced as `artifact://<id>`, with a `[raw output: artifact://<id>]` footer appended (`:663-666`, `:706`). Default artifact budget is **unbounded** (`ARTIFACT_DEFAULT_MAX_BYTES = 0`, `:22-24`) — *"by default, `artifact://<id>` references preserve the complete raw stream instead of a capped head/tail sample."*

Artifact publication is staged and verified (`session/artifacts.ts:31-40`): temp sibling → verify byte count, on-disk size, readability → atomic rename. The reason is stated (`:36-40`): a short write that landed in place *"would leave a truncated file resolvable as incomplete output and a failed follow-up write would destroy the prior valid artifact."*

`bash` also gets a **tool-name sanitiser** for artifact filenames (`artifacts.ts:18-26`) because MCP/extension tool names can contain `/`, `\`, or `..` and would otherwise let a spilled artifact escape the artifacts directory. That is a real path-traversal guard and August's `_spillToolResult` should have the same.

**Artifact reads are protected from elision** — `isArtifactRecoveryToolResult` is in both shake configs' `protectedTools` (`shake.ts:50`, `:63`). Reading back a spilled artifact is never the thing that gets shaken away.

### 5.6 Approval

`docs/approval-mode.md`. Three tiers (`read`/`write`/`exec`), three modes, and a resolution order with one hard rule: a tool-declared `policy: deny` **always** denies, and a user `deny` always denies (`:41-45`). Tools without an `approval` declaration, and malformed decisions, are treated as `exec` — *"This is the safe default for unknown custom tools."*

`resolveApprovalFromContext` (`tools/approval.ts:61-83`) is **fail-closed**: missing context or context with no settings and no `--auto-approve` yields `always-ask` with an empty policy map. It is shared by `ExtensionToolWrapper.execute`, `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude host calls *"so those sites cannot drift."*

Argument-dependent safety (`docs/approval-mode.md:49-58`): `bash` uses object-form approval with `override: true` for `rm -rf /`, fork bombs, remote-fetch-then-execute, writes to `/etc/passwd`, host shutdown. `bash.patterns` rules support `deny | prompt | allow`, and `allowCompoundCommands` (off by default) understands only flat `&&` chains of literal arguments — *"Expansions, assignments, other control flow, redirections, globbing, newlines, malformed syntax, and shell-state-changing builtins do not qualify and retain legacy approval behavior."*

The scope honesty at `:70` is worth quoting: *"This pattern policy controls approval for the `bash` tool; it is not process or filesystem containment. An approved command retains the shell's ambient filesystem, network, and subprocess access."*

August's `tool_policy.py:342-457` (`ApprovalPolicy`, `decide`, `PrefixRule`, `classify_command`) is a close structural match and already has segment-aware shell splitting. The missing piece is the explicit fail-closed statement and the "not containment" disclaimer.

### 5.7 MCP

`docs/mcp-runtime-lifecycle.md`. The startup shape is the transferable part (`:9-16`):

- **Headless/SDK**: await `discoverAndLoadMCPTools`; print mode additionally waits for configured servers' handshakes bounded by `OMP_MCP_TIMEOUT_MS` (default 30 s), or `OMP_MCP_REQUIRE_READY=1` exits 1 without sending the prompt.
- **Interactive/TUI**: construct `MCPManager` immediately, defer `discoverAndConnect()` to a background task, bind tools via `session.refreshMCPTools(...)` — disposing the manager if the session was torn down mid-connect.
- **Fast startup gate waits up to 250 ms** (`:14`) and returns fully-loaded tools, per-server failures, **or cached `DeferredMCPTool`s for still-pending servers**. The session is never blocked on a slow MCP server.
- **Per-server failure is not session failure** (`:64-70`): discovery hard-failure returns one synthetic error; per-server connect failure returns partial success with an errors map.

Manager state is a set of separate registries (`mcp/manager.ts:245`, `:298`): `#connections`, `#pendingConnections`, `#pendingToolLoads`, `#tools`, `#sources`, `#pendingReconnections`, `#serverConfigs` (preserved *unresolved* so reconnect can re-resolve credentials without leaking resolved tokens), plus `#reconnectHistory` + `#epoch` for per-server crash-window accounting and invalidation of reconnects that outlive a global disconnect.

**Tool naming** (`docs/approval-mode.md:29-34`): `mcp__<sanitized_server>_<sanitized_tool>`, redundant `<server>_` prefixes removed, names over 64 chars capped with a deterministic hash suffix — and the user policy must key on the *final* capped name. August's `managed_tool_policy.py` should do the same or users cannot write stable allow/deny rules.

---

## 6. UI/UX (TUI) — what August's React desktop should copy

### 6.1 The rendering contract

`docs/tui-core-renderer.md` and `docs/tui-runtime-internals.md`. The core principle: **finality is an application decision, never an inference from a row crossing the top of the terminal** (`tui-core-renderer.md:16-18`).

The frame handshake (`:22-36`):

```ts
interface HistoryBatch {
  id: number;
  rows: string[];
  kind?: "append" | "replay";
}
```

> A history batch has a monotonic id. The TUI writes each accepted batch exactly once, then acknowledges that id to the provider. The provider retains a pending batch until acknowledgement and does not reuse or reorder ids. This handshake makes retries and coalesced renders safe without requiring the renderer to compare a new transcript with terminal scrollback.

Three transcript states (`tui-runtime-internals.md:44-48`): **active** (mutable, viewport-resident), **settled** (finalized but still live — *"it re-renders at the current width every frame (so resizes reflow it) until capacity pressure retires it"*), **committed** (acknowledged and released). `peekFinalizedBatch(width, capacity)` retires the shortest settled prefix that fits, stops at the first active block, and re-offers the same id until `acknowledgeFinalizedBatch()` succeeds.

The React analogue is a virtualization list with three retention states and an explicit acknowledgement step. August's chat scrollback does not distinguish "settled but reflowable" from "committed".

### 6.2 Ownership boundary

`docs/tui-runtime-internals.md:9-13`:

> - **`packages/tui`** owns terminal lifecycle, input normalization, focus, overlays, image protocols, cursor placement, scheduling, explicit history writes, and mutable viewport painting.
> - **`packages/coding-agent`** owns transcript order, block finality, tool allocation, editor/status chrome.
> - The terminal core never interprets messages, tools, transcript blocks, or finality.

August's `components/chat/` mirrors this reasonably. The missing piece is the *negative* rule — the core list component must not know what a tool call is.

### 6.3 Streaming reveal

`modes/controllers/streaming-reveal.ts`. Three constants define the feel (`streaming-reveal.ts:7-9`): `STREAMING_REVEAL_FRAME_MS = 1000/30`, `MIN_STEP = 3` graphemes, `CATCHUP_FRAMES = 8`. The model is **typewriter reveal with a catch-up budget**, not raw token dumps.

The performance note at `:24-27` is the kind of thing worth internalizing: `requestRender(component)` scopes the render to the changed subtree — *"a full tree walk here at 30fps costs 5% of CPU on its own and drives the Box/Container overhead that cascades into another ~15%."* In React the analogue is a per-block subscription rather than a root re-render per delta.

### 6.4 Tool-call cards

`packages/tui/src/chat/tool-execution.ts:243+`. `ToolExecutionComponent` tracks a lot of state that maps to a good React card:

- `#expanded`, `#isPartial`, `#resultVersion` — the three states a card can be in (`:255`, `:259`, `:264`).
- `#blockVersion` — a post-finalize mutation counter, because *"a tool block can keep changing after `isTranscriptBlockFinalized()` first returns true — an async task's terminal result settlement, seal(), or an expansion toggle"* (`:266-271`).
- `#multiFileBoxes` — per-file sub-boxes for multi-file edits (`:246`).
- `#previewReady: PromiseWithResolvers<void>` — the diff preview resolves asynchronously and the card renders in two phases (`:298`).
- `#parkedBackground` — *"A background task whose call already returned; later async job frames are partial updates, but the block is ready to retire as history"* (`:261-263`).

The AGENTS.md "Streaming tool previews" section is a hard-won warning: preview-only fields like `__partialJson` must survive the live event path, the transcript rebuild, and merged call/result rendering — *"Missing one path causes inconsistent previews."* It also records the bash-specific trap: parsed args lag until the JSON object closes, so inline env assignments only appear at the end; the pending preview must use raw `partialJson`.

August's `ToolCallItem.tsx` / `ToolCallItemBody.tsx` / `ToolStepRow.tsx` are the same surface and would benefit from the `#blockVersion` idea — React's `memo` needs an explicit version prop for exactly this reason.

### 6.5 Sanitization is mandatory on every render path

`AGENTS.md`, "TUI Sanitization": all text displayed in tool renderers must be sanitized — `replaceTabs()`, `truncateToWidth()` / `ui.truncate()`, `shortenPath()` (replaces home with `~`), and `PREVIEW_LIMITS`. *"No ad-hoc numbers."* And critically: *"**Error messages — these often embed file content** (e.g. patch failure messages include unmatched lines)."*

`sanitizeText` (`packages/utils/src/sanitize-text.ts:23-38`) is the belt-and-braces layer: `toWellFormed()` first (repairs lone surrogates), then strips control characters, and strips ANSI when an ESC is present.

### 6.6 Settings UI, themes, keybindings

**Settings** (`docs/settings.md`) — a 6,390-line schema (`config/settings-schema.ts:300`+) where each entry carries `{type, default, ui: {tab, group, label, description, options?}}`. `omp config list --json` emits `{value, type, description}` per path; credentials are masked in human output and omitted in JSON with `redacted: true`. `omp config get <key>` is an explicit single-key request and returns unmasked. `omp config reset <key>` writes the *default* back (it does not delete the key). Value parsing is schema-typed (`:66-76`).

**Themes** (`docs/theme.md`) — JSON with a required color-token set, optional `vars` for reuse, and a `symbols` block with `preset: unicode | nerd | ascii` plus overrides. Tokens include semantic background blocks (`selectedBg`, `userMessageBg`, `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `statusLineBg`) — a good hint that August's status colors should be tokens, not literals in components.

**Keybindings** — `packages/tui/src/app-keybindings.ts`; action ids like `app.interrupt`, `app.agents.hub`, `app.session.observe` are matched rather than raw keys, and are remappable in `~/.omp/agent/keybindings.yml` (`docs/agent-hub.md:15-20`).

### 6.7 Agent Hub — the subagent control surface

`docs/agent-hub.md`. Opened with `Alt+A` (or `Ctrl+S`, or double-tap `←` from an empty editor). The roster row shows status, identity, parent, unread IRC count, model role + resolved model, age since last activity, assigned task, and cost/tokens/request/tool-call counts (`:26-31`). Missing data renders as `usage —` *"rather than an estimate"* (`:42`). `t` toggles flat vs parent/child tree; `Tab` swaps roster for inspector on narrow terminals.

`Enter` focuses the subagent **in the main TUI** — transcript, status line, and editor all become the subagent's, and typing steers it through the normal prompt path so the message lands in the subagent's *persisted* history (`:61-69`). `r` revives a parked agent, `x` kills one. A pinned `Subagents` block above the editor lists every live agent, collapsed by default (`:73-75`).

Resumed sessions discover parked subagents by scanning the artifact tree; killed agents keep a tombstone so they still render as aborted, and nested agents retain lineage (`:83`). Advisor transcripts appear as read-only rows that cannot be messaged, revived, or killed (`:85-92`).

August has `SubagentTimeline.tsx`, `SubagentDelegateRow.tsx`, `TaskProgressPill.tsx`, and `focused-subagent.ts` — the roster-with-control model is the gap.

---

## 7. Settings / config

### 7.1 Five scopes with an explicit precedence chain

`docs/settings.md:13-22`, `:120-127`:

```
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

| Scope | Path | Write |
|---|---|---|
| Global | `~/.omp/agent/config.yml` | `/settings`, `omp config set/reset` |
| Global legacy | `~/.omp/agent/settings.json` | migrated once, renamed to `.bak` |
| Project | `<cwd>/.omp/config.yml` (+ legacy `.json`) | **only** `modelRoles` when `modelRoleStorage: project` |
| CLI overlay | any `--config <file>`, repeatable | never persisted |
| Runtime override | in-memory | never persisted |

Two rules August should copy verbatim:

- **Writes are debounced and re-read under a lock**, *"so external edits made while a session is open are preserved"* (`:104`).
- **An invalid persistent settings file is moved to a uniquely named `.broken-*` backup and the process exits with the original error** (`:48`). It is not silently replaced with defaults.

**Merge rules** (`:129-134`): objects deep-merge, scalars and arrays are replaced wholesale — *"A higher layer's array does not append to a lower layer's array."*

**Environment variables are not a settings layer** (`:96`): each is read by the feature that owns it, usually as a per-machine override or fallback, and is never written back to `config.yml`.

**Project settings do not walk ancestors** (`:36`): discovery is scoped to the process cwd's `.omp/` only.

August has `brain_config_service.py` (`getDefaults`/`_loadPersisted`/`_savePersisted`/`validatePatch`, `:194-297`) and `config_service.py`. The missing piece is the broken-file backup and the external-edit-preservation rule.

### 7.2 Schema as the single source of truth

`omp config` exposes the complete schema; `/settings` exposes only entries with UI metadata (`docs/settings.md:5-6`). Every key, type, default, and enum comes from `SETTINGS_SCHEMA` — there is no second copy of a default anywhere. `docs/compaction.md:485-514` then lists every consumed default with its value, and `AGENTS.md` notes the repo's own convention of guarding duplicated numbers with a doc check.

August has `AGENTS.md` guarding duplicated numbers with `npm run check:docs` — the same discipline — but its defaults are spread across `_defaultsCamel()` (`brain_config_service.py:194`) and per-module constants.

---

## 8. Lifecycle

### 8.1 Startup

`packages/coding-agent/src/modes/runtime-init.ts` + `session/setup.ts`. Two details that matter for a Tauri shell:

- **MCP is deferred in interactive mode** (`docs/mcp-runtime-lifecycle.md:12`) so the first paint is not gated on third-party servers.
- **The worker host re-enters the single CLI entrypoint** (`AGENTS.md`, "Worker scripts"): `cli.ts` declares itself as the worker host and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, …). History (`:6-7`): raw-asset workers *"crashed silently in compiled binaries"*, and the literal-path + extra-entrypoint pattern *"required keeping spawn literals and two build scripts in sync."* The smoke probe (`omp --smoke-test`) is wired into CI so binary, source-link, and tarball installs all exercise the contract.

August ships a Tauri app, so the worker story is different — but the lesson about *smoke-probing the packaged artifact's spawn path* is not.

### 8.2 Shutdown

`modes/session-teardown.ts:1-10` — signal-safe teardown shared by the keypress path and the `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handlers, so *"a real kernel signal executes the exact same teardown as a keypress exit."* The teardown is **idempotent and promise-memoized** (`:39-45`): concurrent invocations share one settled promise and only the first call's reason is used.

The ordering is deliberate (`:16-30`): snapshot the editor draft → **synchronously** mark disposing (closing the async gap where deferred jobs could start after a signal but before `disposeSession`) → `saveDraft` (draft-loss protection for `--resume`) → `disposeSession`.

### 8.3 Session restore and crash recovery

Session files are JSONL, one entry per line, with a fixed-width 256-byte `title` slot physically first (`docs/session.md:63-66`). The entry taxonomy (`docs/session.md:110-127`) includes `message`, `thinking_level_change`, `model_change`, `service_tier_change`, `compaction`, `branch_summary`, `reset_boundary`, `custom`, `custom_message`, `label`, `title_change`, `ttsr_injection`, `credential_pin`, `session_init`, `mode_change`.

**Branch navigation moves a pointer, not entries** (`docs/session.md:67`): `leafId` moves; nothing is rewritten.

`switchSession` is guarded with a full rollback (`docs/session-operations-export-share-fork-resume.md:345`): *"If a throwing step in the guarded transition fails, `switchSession()` restores the captured session, agent queues/messages, tools/prompts, model/thinking/service-tier, provider/cache, memory, and checkpoint state."*

`/fresh` resets provider stream state without touching the local transcript (`:167`) — the documented escape hatch for *"a wedged or corrupted provider stream (stale prompt cache, ...)"*.

**Crash detection is a persisted marker, not a heuristic** — `session/exit-diagnostics.ts:17-43`. A `tool_execution_start` marker with a compact argument summary (command/path only, not full args — *"without duplicating whole argument payloads into the session JSONL"*, `:9-14`) is written *before* the tool runs. A `session_exit` entry records `{reason, kind: normal | signal | fatal | process_exit, recordedAt, pendingToolCalls}`. On the next launch, a tool call with a start marker and no matching result is a known-incomplete call, and the exit kind tells you whether the process died or exited cleanly.

August has `durability.py:47` `strip_tail_patches` and `:66` `flush_session_barrier` — both about not persisting a torn tail — but no per-tool start marker and no exit-reason record.

### 8.4 Durability contract (stated, not assumed)

`session/session-manager.ts:690-704`:

> Durability is software-crash safe but not power-loss safe: completed entries ... are handed to the OS synchronously in-body on append and never `fsync`'d. In-flight streaming text is intentionally not durable until `message_end` persists the finished message.

And the concurrent-rewrite interlock (`:696-700`): while an atomic rewrite is publishing, a concurrent completed append supersedes it with a synchronous full-body rewrite; the abandoned atomic's `commitGuard` then refuses to clobber the fresher body. The supporting types are `SessionWriteConflictError` (`session-storage.ts:63`, keyed on `(mtime, size)`-equivalent `expectedSize`) and `SessionLockError` (`:84`, fail-closed — *"The staged rewrite was discarded without publishing"*).

Atomic file replacement has a **Windows-aware fallback** (`utils/atomic-file.ts:8-66`): `rename` → on `EPERM`/`EEXIST`, rename the target to a `.bak`, rename the temp in, and roll back on failure. Cross-device moves verify `(ino, size, mtimeNs)` before and after the copy and `fsync` the staging file before `link`+`unlink` (`:68-90`).

### 8.5 Updates

No auto-updater in the CLI package; `settings-schema.ts:2167` has `marketplace.autoUpdate` for the plugin marketplace, and `omp update` plus a startup update check are driven by an `update.channel` setting (`:2159`). Not a source for a Tauri updater design.

---

## 9. Testing & robustness

### 9.1 Test philosophy, written down

`AGENTS.md`, "Testing Guidance" — the strictest section in either repo's docs:

- *"Every new test must defend one **concrete, externally observable contract**. If you cannot name the contract, do not add the test."*
- **Banned test shapes**: static echo (testing a constructor that copied a fixture), success passthrough (`fn(x) === x` for already-valid input), wording/defaults (`expect(prompt).toContain("…")`, `not.toThrow()`, non-empty checks, length-grew checks), duplicate rows, and **source-grep** — *"A test that reads an implementation file and asserts on its _text_ ... is banned. It tests how code _looks_, not what it _does_."*
- **Metadata exception**: exact metadata/ordering may be asserted only when a downstream consumer depends on the exact bytes.
- **Termination exception**: for cyclic/large inputs, assert a bounded output, surfaced error, or state change; bare `not.toThrow()` is insufficient.
- **Full-suite safety**: no file-wide mutations of `Bun.*`, `process.platform`, `process.env`. *"A test that passes alone but poisons later files is broken."*
- **`mock.module()` is banned** — it mutates the global module registry and leaks across files. Use `vi.spyOn` + `vi.restoreAllMocks()` in `afterEach`.

August's `test:frontend` and `pytest` suites would benefit from the source-grep ban and the "name the consumer-observable failure" requirement.

### 9.2 Test scale and shape

- `packages/coding-agent/test/` — 815 files
- `packages/tui/test/` — 232
- `packages/agent/test/` — 48
- `packages/agent/test/agent-loop.test.ts` alone: 148 `it(`/`test(` cases across 9 `describe` blocks (`:50`, `:3592`, `:4095`, `:4677`, `:4731`, `:4981`, `:6034`, `:6279`, `:6477`)

The test *names* are the specification. Representative ones (`packages/agent/test/`, from the file listing): `agent-loop-trailing-finalize.test.ts`, `compaction-cut-point.test.ts`, `compaction-reserve-provenance.test.ts`, `context-tokens-orchestration.test.ts`, `continue-empty-transcript.test.ts`, `instrumented-oneshot-retry.test.ts`, `agent-side-request-context.test.ts`.

In `packages/coding-agent/test/session/`: `indexed-late-atomic-rollback.test.ts`, `publish-lock-os-gate.test.ts`, `session-manager-indexed-durability.test.ts`, `empty-error-turn.test.ts`, `rpc-auto-maintenance-scope.test.ts`, `session-provider-boundary-image.test.ts`.

The naming convention is the lesson: **`indexed-late-atomic-rollback`, `publish-lock-os-gate`, `empty-error-turn`** each name a race or edge that a reader would otherwise have to reconstruct.

### 9.3 CI and smoke

`package.json:114-124`:

```json
"ci:test:full": "bun run ci:test:ts && bun run test:rs",
"ci:test:smoke": "bun packages/coding-agent/src/cli.ts --version && … --help && … stats --help && … --smoke-test",
"ci:test:install-methods": "bash scripts/install-tests/run-ci.sh",
```

Rust uses `cargo nextest run` **plus** `cargo test --doc` (`AGENTS.md`), because nextest does not execute doctests. `bun check` replaces `tsc`.

The install-methods CI (`scripts/install-tests/run-ci.sh`) exercises binary, source-link, and tarball installs — i.e. the *packaged* artifact, not just the source tree.

### 9.4 Atomic writes and idempotency

Covered in §8.4. The two primitives August should adopt:

- `replaceFileAtomically` with a Windows `EPERM`/`EEXIST` backup-rollback path (`utils/atomic-file.ts:8-66`).
- `writeTextAtomic` with `expectedSize` + a synchronous `commitGuard()` that fires *"immediately before it makes the staged content visible at `path`"*, and the contract *"Backends MUST NOT yield between the checks and publishing the write"* (`session-storage.ts:96-105`).

---

## 10. Transferable to August — ranked

### P0

---

**P0-1. Synthetic tool-result pairing on every exit path, with an `__synthetic` discriminator**

- **What the repo does.** Four sites in `executeToolCalls`/`runLoopBody` guarantee every emitted `toolCall` gets exactly one matching result: provider error/abort (`agent-loop.ts:1471-1513`), non-runnable stop (`:1615-1639`), post-batch orphan tail sweep (`:3494-3504`), and resume-tail replay (`:1222-1258`). Synthetic results carry `__synthetic === true` and a `source` so the UI can render "call emitted, not executed" rather than "tool failed" (`:3526-3545`).
- **August files.** `backend-py/app/services/workbench/workbench.py` (`_executeTool` at `:5609`, the truncation/pairing paths at `:5237` and `:5348`), `backend-py/app/services/workbench/stream_translate.py`, `backend-py/app/services/turn_outcomes.py` (add a `synthetic_results` counter next to the existing `malformed_tool_args`).
- **Why.** A missing `tool_result` is a hard 400 from every strict provider, and today August's protection is scattered across truncation branches that can disagree with each other. The `__synthetic` flag also fixes the telemetry lie where a provider-side stream error after tool emission is reported as a local tool failure (upstream issue #4321).
- **Effort.** M. **Risk.** Low — additive; the pairing path is a single helper.

---

**P0-2. `coerceToolResult` as a mandatory choke point for tool results**

- **What the repo does.** `agent-loop.ts:521-592` normalizes *every* tool result before it reaches history: non-array `content` → readable error; malformed blocks dropped with a counted notice; `sanitizeText` on text; non-empty body forced when `isError` (Anthropic rejects empty `tool_result` with `is_error: true`); `useless` never combined with `isError`. Applied equally to `execute`, `afterToolCall`, and speculative returns (`:3228`, `:3313-3321`).
- **August files.** `backend-py/app/services/workbench/workbench.py` — add a `coerce_tool_result()` next to `_truncateToolOutput` (`:670`); wire it at the single return point of `_executeTool` (`:5609`) and at the async-job result paths.
- **Why.** August has `json_salvage.py` for *arguments* and nothing for *results*. A tool returning a bare string, a non-list, or a dict of the wrong shape is persisted verbatim today, and that is both a provider 400 and a permanent transcript corruption. The empty-error-body rule alone fixes a real Anthropic failure mode.
- **Effort.** S. **Risk.** Low.

---

**P0-3. `useless` flag → in-place elision, on three consumption paths**

- **What the repo does.** `AgentToolResult.useless` (`types.ts:956-957`) marks a finished result as contextually useless. It is consumed by a per-turn stale pass, by `pruneToolOutputs` (bypassing the protect window), and by summary serialization (dropping the whole call/result pair) — `docs/compaction.md:228-236`. Never on the wire, never with `isError`, never removed from history (only blanked to `[Uneventful result elided]`, `pruning.ts:70`), and never when the notice costs more than the result (`pruning.ts:237-238`).
- **August files.** `backend-py/app/services/workbench/context_compressor.py` (`pruneToolOutputs` at `:209`, `_pruneOne` at `:197`, `USELESS_NOTICE` equivalent), `backend-py/app/services/tools/tool_result.py` (result builder), `backend-py/app/services/workbench/turn_outcomes.py`.
- **Why.** August's `pruneToolOutputs` blanks by token count only. Zero-hit `search_files`, a `wait` that returned nothing new, and a `list_directory` that repeated a previous listing are all real context tax; the flag is the cheapest signal available and it is already produced by the tools that know.
- **Effort.** S–M. **Risk.** Low — the "never remove from history" rule is the safety property; keep it.

---

**P0-4. Three-queue boundary (steering / aside / follow-up) with a discard hook**

- **What the repo does.** `agent-loop.ts:1261-1269`, `:1680-1690`, `:1709-1715`. Asides are resolved at the moment of injection via sync thunks (`:1128-1141`) so a producer can drop late diagnostics superseded by newer state; anything uncommitted at loop exit is explicitly discarded through a hook (`:1723-1724`). A passive aside can never trigger a model turn on its own.
- **August files.** `backend-py/app/services/workbench/workbench.py` (the `pendingMessages`/steering path around `:3590-3625`), `backend-py/app/services/workbench/turn_close.py` (`persistAndClose` at `:380`).
- **Why.** August's `[Proxy Self-Heal]` nudge, the advisor-style diagnostics, and the plan-state block all behave like asides today, and a stale one can start a turn the user did not ask for. The discard hook also gives August a clean answer to "what happens to a reflection nudge when the turn ends before it fires."
- **Effort.** M. **Risk.** Medium — this is the loop's central control flow. Land behind the existing self-heal gate and keep the single-queue path as a fallback.

---

**P0-5. Replay-safety veto on retry**

- **What the repo does.** `turn-recovery.ts:1312-1321` refuses to retry any turn that already emitted visible text, images, or server-tool blocks, with one narrow exception (`:1330-1360`): if every emitted tool call has a synthetic result marked `executed === false`, the turn proves nothing ran and replay is safe. The error taxonomy is a bitmask (`packages/ai/src/error/flags.ts:20-46`) so facts compose, and `retriable()` refuses unconditionally on `ContentBlocked` / `PayloadRejected` (`:374-380`).
- **August files.** `backend-py/app/services/workbench/workbench.py` (the retry/self-heal path), `backend-py/app/services/harness_ops.py`, `backend-py/app/services/fallback_service.py`, `backend-py/app/services/workbench/turn_outcomes.py`.
- **Why.** August's eight-family taxonomy is string-shaped and has no replay-safety concept at all. A retry after a partially-committed turn duplicates whatever the model already said or did. This is the single highest-value correctness idea in the repo.
- **Effort.** M. **Risk.** Medium — needs the `__synthetic`/`executed: false` metadata from P0-1 to be useful.

---

**P0-6. Output-cap fitting against the context window**

- **What the repo does.** `output-budget.ts:48-66`. Prompt tokens are counted locally, padded by 10% for tokenizer disagreement (`:15`), and `max_tokens` is lowered to the remaining room (floor 1,024) so a nearly-full window stops on `length` rather than 400-ing. Framing tokens (system prompt + tool schemas) are memoized in a `WeakMap` keyed on array identity + length (`output-budget.ts:74-108`).
- **August files.** `backend-py/app/services/workbench/token_budget.py` (`computeBudget` at `:65`, `estimateTokens` at `:24`, `_flattenMessages` at `:201`), `backend-py/app/services/workbench/providers.py`, `backend-py/app/services/workbench/managed_tool_policy.py`.
- **Why.** `token_budget.py:201` flattens every message into one string and has no notion of the output cap. August will hit the same failure oh-my-pi documents: a model with a large `maxTokens` (DeepSeek V4's ~384k of a ~1M window) makes *every* request fail once the prompt passes window-minus-cap, long before compaction triggers, and side turns (BTW, recap) have no overflow recovery at all. The `WeakMap` framing memo is the cheap half.
- **Effort.** S–M. **Risk.** Low.

---

**P0-7. Fail-closed approval resolution shared by every call site**

- **What the repo does.** `tools/approval.ts:61-83` — missing context or context without settings/`--auto-approve` yields `always-ask` with an empty policy map. The function is shared by `ExtensionToolWrapper.execute`, `refuseByWritePolicy`, `mcpApprovalPreflight`, and eval prelude calls *"so those sites cannot drift."* Unknown tools default to `exec` tier (`docs/approval-mode.md:19`). A tool-declared `policy: deny` and a user `deny` both always win (`:41-45`).
- **August files.** `backend-py/app/services/tool_policy.py` (`ApprovalPolicy` `:342`, `decide` `:406`, `needs_approval_in` `:297`), `backend-py/app/services/tool_registry.py` (`dispatch` at `:625`), `backend-py/app/services/workbench/permissions.py` (`decide` at `:406`), `backend-py/app/services/workbench/kernel.py` (the bridge path).
- **Why.** August's code-mode kernel bridges back into the managed tool surface and re-applies "the same guard / approval gates as the typed loop" (`kernel.py:5-9`) — that is exactly the kind of second call site where policy drifts. One resolver, fail-closed, no per-site defaults.
- **Effort.** S. **Risk.** Low — the `decide` shape already exists.

---

### P1

---

**P1-1. Artifact spill with a guaranteed retrievable pointer**

- **What the repo does.** Tool output over the cap spills to a session artifact; the inline result keeps a bounded head+tail plus a `[raw output: artifact://<id>]` footer (`streaming-output.ts:663-666`, `:697-709`). The artifact is staged, verified (byte count, on-disk size, readability), then atomically renamed (`session/artifacts.ts:31-40`). Default artifact budget is **unbounded** — the complete raw stream is preserved (`:22-24`). Artifact-recovery reads are protected from compaction elision (`shake.ts:50`).
- **August files.** `backend-py/app/services/workbench/workbench.py` (`_SPILL_THRESHOLD_CHARS` at `:716`, `_spillToolResult` at `:759`, `_SPILL_RETRIEVAL_TOOLS` at `:721`), `backend-py/app/services/tools/artifact_tools.py`, `backend-py/app/services/sandbox/`.
- **Why.** August spills at 50 KB with a head/tail preview and a retrieval-tool allowlist, but the spill path has **no** atomic publication, **no** tool-name filename sanitiser (August's tool names can come from MCP), and **no** protection from the pruner blanking the retrieval read. `artifacts.ts:18-26` and `shake.ts:50` are the two guards August is missing.
- **Effort.** M. **Risk.** Low–Medium (path-traversal fix is a security change; do it in the same PR).

---

**P1-2. Two-lane tool scheduler with per-call concurrency resolution**

- **What the repo does.** `agent-loop.ts:3456-3482` — shared tools run in parallel; an `exclusive` tool waits for every shared task plus the previous exclusive, then becomes the new barrier. Resolution is on the hook-revised args, with a throwing resolver falling back to `exclusive` (safe). `bash` declares `pty → exclusive, else shared` (`tools/bash.ts:574-575`). Results are emitted **in batch order**, not completion order (`:3152-3162`).
- **August files.** `backend-py/app/services/workbench/parallel_tools.py` (the current `PARALLEL_SAFE_TOOLS` frozenset at `:17-38`), `backend-py/app/services/workbench/managed_tool_policy.py` (`isManagedToolParallelSafe` at `:24`), `backend-py/app/services/workbench/workbench.py` (`run_regular_tools_stage` near `:5357`).
- **Why.** August's model is allowlist-only: a tool is either always-parallel or always-serial. `bash` with a PTY is the canonical case that needs to be serial *sometimes*. Also, August should assert that results land in call order — the transcript is read by humans and by the episode miner.
- **Effort.** M. **Risk.** Medium — `bash` PTY exclusivity in particular, since August's terminal service has its own locking.

---

**P1-3. Three-tier interrupt policy (hard / cooperative / never)**

- **What the repo does.** `agent-loop.ts:2935-2956`. Interruptible pure waits get the full signal set; every other tool gets **only** the external signal, because *"neither queued steering nor a peer IRC ever hard-kills a partially side-effecting foreground tool."* A separate cooperative signal rides `ctx.steeringSignal`; tools may react and ignoring it is always safe. The skip rule is then explicit: non-interruptible work is never skipped, because *"a skip only makes the model re-emit the same call after the steer lands (#10439)."* The 250 ms poll (`:3449-3455`) is guarded (`:3380` — an unguarded rejection *"poisons the `start.then(runTool)` ordering chain"*).
- **August files.** `backend-py/app/services/workbench/workbench.py` (the steering/steer path and `run_regular_tools_stage`), `backend-py/app/services/workbench/pty_io.py`, `backend-py/app/services/workbench/terminal_service.py`.
- **Why.** August has a `wait` tool and queued steering, and currently a steer either does nothing or aborts everything. The three tiers are what make mid-turn steering safe, and the `checkSteering().catch(() => undefined)` guard is a one-line fix for a whole class of batch corruption.
- **Effort.** M–L. **Risk.** Medium–High — touches the tool-execution path. Land the guard first (S, standalone).

---

**P1-4. Retry backoff with jitter, header hints, and credential/model fallback**

- **What the repo does.** `docs/non-compaction-retry-policy.md:73-124`. `min(base * 2^(attempt-1), 8000ms) * (75–100% jitter)`, defaults `enabled/maxRetries=10/baseDelayMs=500/maxDelayMs=300000`. Delay overrides come from `retry-after-ms`, `retry-after`, `x-ratelimit-reset-ms`, `x-ratelimit-reset` (`:124`). Credential/model switches set delay to 0. `abort()` calls `abortRetry()` *before* aborting the stream (`:142`). Context overflow is explicitly excluded and delegated to compaction (`:24-28`).
- **August files.** `backend-py/app/services/workbench/workbench.py`, `backend-py/app/services/fallback_service.py`, `backend-py/app/services/provider_credentials.py`, `backend-py/app/services/quota_observation.py`.
- **Why.** August has a fallback service and a quota endpoint but no documented, bounded, jittered backoff contract, and no statement that overflow is *not* a retryable error. The 75–100% jitter matters: concurrent August sessions retrying a shared gateway in lockstep is a real failure mode.
- **Effort.** M. **Risk.** Low.

---

**P1-5. Soft tool requirement as a gate, not a nudge**

- **What the repo does.** `agent-loop.ts:1546-1591`. A host-declared soft requirement injects reminders, and if the turn calls the wrong tool the loop **discards** the speculative work, pairs each call with a `skipped` result, and forces the required tool next turn — capped at `MAX_SOFT_TOOL_ESCALATIONS = 3` (`:120`). *"A required+detour batch is treated as non-compliant so detour tools never run side effects while the requirement is still pending."*
- **August files.** `backend-py/app/services/workbench/workbench.py` (the self-heal gate and `update_state`), `backend-py/app/services/workbench/managed_tool_policy.py`, `backend-py/app/services/capabilities_prompt.py`.
- **Why.** August's `update_state(phase=…)` reflection nudge is advisory and fires after 8 stalled rounds. Making it a gate for the specific case where the model called a detour tool while the phase never advanced is a strict improvement, and the cap keeps it from becoming a force loop.
- **Effort.** M. **Risk.** Medium — a gate that fires wrongly blocks work. Start advisory-with-strong-nudge, measure, then gate.

---

**P1-6. Subagent yield contract with a forced final yield**

- **What the repo does.** `task/executor.ts:2093-2228`. The reminder ladder skips retries on a terminal error (`:2184-2185`), forces `toolChoice: yield` on the final retry (`:2194-2206`), and collapses to a single forced yield on budget stop (`:2174-2179`). Missing yield produces named warnings (`executor.ts:661-665`) and, under a schema, a non-zero exit. `finalizeSubprocessOutput` (`:692-839`) is a complete normalization state machine including a stdout-JSON fallback completion path (`:790-824`).
- **August files.** `backend-py/app/services/subagent_worker.py` (`runSubagent` at `:24`, already takes `yieldSchema`), `backend-py/app/services/subagent_orchestrator.py` (`waitForAll` at `:584`, `waitForEach` at `:594`), `backend-py/app/routers/subagent.py`.
- **Why.** August already has `yieldSchema`; what it lacks is the *terminal* side — a bounded reminder ladder, a forced final yield so a hard budget stop still returns partial findings as a real report, and the missing-yield detection that distinguishes "child returned nothing" from "child did 40 requests and was cancelled" (upstream's `formatResultOutputFallback`, `result-summary.ts:22-27`).
- **Effort.** M. **Risk.** Medium.

---

**P1-7. Transcript compaction divider (display context ≠ LLM context)**

- **What the repo does.** `docs/compaction.md:209`. The TUI renders the full path in chronological order with each compaction as an inline divider `── 📷 compacted · ctrl+o ──`; only the LLM context resets. Preserved across resume.
- **August files.** `frontend/desktop/src/components/chat/` (add a `CompactionDivider.tsx` beside `ThinkingDisclosure.tsx` / `DisclosureRow.tsx`), `backend-py/app/services/workbench/state_blocks.py` (`_compactionNotice` at `:123`), `backend-py/app/services/workbench/context_compressor.py`.
- **Why.** August's transcript above a compaction is currently lost or visually conflated with the notice. Users debugging "what did the model actually see" get a strictly better artifact. This is a small, high-visibility change.
- **Effort.** S–M. **Risk.** Low.

---

**P1-8. `turn_outcomes` ↔ `AgentRunSummary` parity**

- **What the repo does.** `run-collector.ts:68-97`. `AgentRunSummary` is a pure rollup with no span references and no live state — *"Safe to persist / diff / assert"* — with per-tool counters `{total, ok, error, skipped, blocked, timeout, aborted, totalLatencyMs, byName}` and per-stop-reason chat counts. Skipped tools that bypass spans are recorded explicitly (`agent-loop.ts:1501-1505`, `:3497-3501`).
- **August files.** `backend-py/app/services/turn_outcomes.py` (the existing row + `record_turn_end`), `backend-py/app/services/workbench/turn_close.py` (`turnTelemetry` at `:180`), `backend-py/app/services/logger.py`.
- **Why.** August's `turn_outcomes` row already carries `end_reason`/`rounds`/counters per `AGENTS.md`; it is missing the *tool-level* breakdown with `skipped`/`blocked`/`aborted` as distinct from `error`. The upstream comment at `:1496-1500` explains why this matters: without the mirror, the run summary's tool counters do not reflect what the user saw on the wire.
- **Effort.** S. **Risk.** Low.

---

**P1-9. `beforeToolCall` runs in the prepare phase, failures surface in the scheduled slot**

- **What the repo does.** `prepareToolCallDispatch` (`agent-loop.ts:2741+`) runs intent extraction, argument validation, and `beforeToolCall` **in call order, before `message_end`**, so a hook's `args` revision is the single source of truth for history, execution events, persistence, provider replay, concurrency scheduling, and `execute` (`:2732-2741`). Failures are recorded per call and emitted at the record's scheduled slot (`:3152-3162`).
- **August files.** `backend-py/app/services/workbench/edit_verification.py`, `backend-py/app/services/workbench/tool_guardrails.py` (`ToolCallTracker.check` at `:79`), `backend-py/app/services/hooks/`, `backend-py/app/services/workbench/workbench.py` (`_executeTool` at `:5609`).
- **Why.** August's guardrails and edit-verification run at execution time today. Running validation first means a blocked call never reaches the transcript as if it ran, and one revision point avoids the "preview says X, execution did Y" class of bug that oh-my-pi's AGENTS.md warns about at length.
- **Effort.** M. **Risk.** Medium.

---

### P2

---

**P2-1. Time-Traveling Stream Rules (TTSR)**

- **What the repo does.** Rule regexes / ast-grep patterns / judge questions match the *in-flight* stream; a match aborts mid-token, injects the rule, and retries from the same point (`docs/ttsr-injection-lifecycle.md:116-152`). Non-interrupting tool matches prepend a `<system-reminder>` to the matched tool's result (`:157-166`). Repeat policy is `once` or `after-gap` in completed turns (`:177-191`). Injections persist and survive compaction (`:220-238`). A 50 ms retry with a four-way identity guard closes the race (`:128-130`).
- **August files.** `backend-py/app/services/workbench/tool_guardrails.py`, `backend-py/app/services/workbench/stream_translate.py`, `backend-py/app/services/memory_store/fact_retrieval.py`, `backend-py/app/services/refine_store.py`, new `backend-py/app/services/stream_rules.py`.
- **Why.** This is the most distinctive self-correction mechanism in the repo and it directly generalizes August's guardrail counters from *after the fact* to *mid-stream*. It is also the most expensive to build.
- **Effort.** L. **Risk.** High — mid-stream abort/retry is a new failure surface. Gate it behind a setting and ship the non-interrupting tool-result path first (that half is M and safe).

---

**P2-2. Advisor model (advisory, not a verifier)**

- **What the repo does.** A second model with its own `Agent` and `ToolSession`, reading only the transcript **delta** (`docs/advisor-watchdog.md:90`), severity-graded `nit`/`concern`/`blocker` (`:123-127`), with explicit recursion filtering (`:94`) and explicit reset on compaction/switch/fork (`:96-103`). It cannot approve actions or mutate primary state (`:5`).
- **August files.** `backend-py/app/services/subagent_worker.py` (reuse the worker with a restricted tool set), `backend-py/app/services/post_observation.py`, `backend-py/app/services/harness_self_improve.py`, `backend-py/app/services/memory_store/messages.py`.
- **Why.** August *removed* its verifier (`AGENTS.md`), and that removal was correct — a gate that withholds answers is the wrong shape. The advisor is explicitly non-blocking and non-mutating, which is why it is worth a second look. The delta-only design and the recursion filter are what keep it cheap and safe.
- **Effort.** L. **Risk.** Medium — cost per turn. The `nit` tier with mid-work aside delivery is the safe subset to build first.

---

**P2-3. `loadMode` / discoverable tools**

- **What the repo does.** `ToolLoadMode` (`types.ts:976-985`) moves an enabled tool's schema off every request, either behind `xd://` device URLs or BM25 tool search. `ESSENTIAL_BUILTIN_TOOL_NAMES` (`tools/essential-tools.ts:21-44`) pins 14 names and makes a UI re-register unable to demote them.
- **August files.** `backend-py/app/services/workbench/managed_tool_policy.py`, `backend-py/app/services/tool_registry.py` (`listTools` at `:560`, `schema_param_hint` at `:597`), `backend-py/app/services/tool_definitions.py`, `backend-py/app/services/tool_bridges.py`.
- **Why.** August's `toolSurface` (`full`/`reduced`/`bare`) + `maxTools` (`workbench.py:1938-1940`) truncates the list at a count. Discoverable tools keep the *count* low without removing *capability* — a much better trade on weak models that drown in schemas.
- **Effort.** M. **Risk.** Medium — the model must be told the tool exists somewhere, or it will never call it. BM25 search is the safer half; `xd://` device dispatch is not.

---

**P2-4. Prewalk (one-shot frontier → cheap handoff)**

- **What the repo does.** `docs/prewalk.md`. Arm prewalk, let the frontier model explore and plan, switch to `@smol` after the first completed `edit`/`write`, once.
- **August files.** `backend-py/app/services/workbench/model_fleet.py`, `backend-py/app/services/model_fleet_service.py`, `backend-py/app/services/workbench/state_blocks.py` (the plan-state block that opens the gate), `backend-py/app/services/workbench/workbench.py`.
- **Why.** Directly attacks August's per-model cost, and August already has role-based model selection and a plan-state block. The gate condition (todo written → first write done) is unambiguous and does not require a new model-quality signal.
- **Effort.** M. **Risk.** Medium — a wrong handoff mid-edit is worse than no handoff. Make it opt-in per model and one-shot.

---

**P2-5. `MIN_PRUNE_TOKENS` and the "no-savings prune" floor**

- **What the repo does.** `pruning.ts:123` `MIN_PRUNE_TOKENS = 50`, with the reason at `docs/compaction.md:219`: the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a small result *"would grow the context and churn the prompt cache for nothing."*
- **August files.** `backend-py/app/services/workbench/context_compressor.py` (`_pruneOne` at `:197`, `pruneToolOutputs` at `:209`).
- **Why.** Trivially small change; if August's placeholder is longer than 8 tokens the arithmetic differs, but the principle (measure, don't guess) is worth writing into the code.
- **Effort.** S. **Risk.** Low.

---

**P2-6. Token accounting that distinguishes replayed from orchestration-only tokens**

- **What the repo does.** `docs/compaction.md:129` — `calculateContextTokens` (`compaction/compaction.ts:270`) *"subtracts provider-side orchestration tokens (billable, but never replayed into the conversation prefix) so auto-compaction and context-promotion thresholds are not inflated by them."*
- **August files.** `backend-py/app/services/workbench/token_budget.py` (`_flattenMessages` at `:201`, `computeBudget` at `:65`).
- **Why.** August flattens everything, so a turn's measured context is inflated by tokens the provider never replays — meaning compaction fires early and the threshold is calibrated against a number that does not exist.
- **Effort.** M. **Risk.** Low.

---

**P2-7. Branded 3-level retry TUI surface + `session_exit` marker**

- **What the repo does.** Retry renders as `Retrying (attempt/maxAttempts) in Ns… (esc to cancel)` with `Esc` dispatching on live session state (`docs/non-compaction-retry-policy.md:146-153`). Separately, `exit-diagnostics.ts:17-43` persists a `tool_execution_start` marker (command/path only) before each tool and a `session_exit` entry with `{reason, kind, pendingToolCalls}`.
- **August files.** `frontend/desktop/src/components/overlays/` (an `ApprovalBanner.tsx` sibling), `frontend/desktop/src/components/chat/WorkingIndicator.tsx`, `backend-py/app/services/workbench/durability.py`, `backend-py/app/services/workbench/sessions.py` (the SQLite session row).
- **Why.** The retry surface is small and high-value: right now a user watching an August turn retry cannot tell a retry from a hang. The `session_exit` marker plus per-tool start markers give August a real "this tool was in flight when the app died" signal instead of inferring it from a truncated tail.
- **Effort.** S (surface) / M (markers). **Risk.** Low.

---

**P2-8. Rulebook / KDL for model-and-provider policy**

- **What the repo does.** `AGENTS.md`, "Model/Provider Policy Lives in KDL" — no `id.includes("claude")` anywhere; all of it in `.kdl` rules compiled to a committed `rules.json` with `AmbiguousOverlapError` on equal-rank collisions. Plus rule discovery from eight foreign formats on first run (README feature 15).
- **August files.** `backend-py/app/services/cost_estimator.py`, `backend-py/app/services/model_service.py`, `backend-py/app/services/capabilities_prompt.py`, `backend-py/app/services/tool_bridges.py`, new `backend-py/app/services/catalog_rules/`.
- **Why.** August's `AGENTS.md` already forbids a second rate table; this is the same discipline applied to the whole model catalog, with a build-time ambiguity check. The foreign-format rule import is a genuine adoption win (`.claude`, `.cursor`, `.codex`, `AGENTS.md`, Copilot `applyTo`).
- **Effort.** L. **Risk.** High — a policy move this large touches pricing, routing, and the capabilities prompt simultaneously. Not a P0 despite the appeal.

---

## 11. Do not copy / traps

**Do not copy the 11,674-line `agent-session.ts`.** It is the accumulated result of a very long-lived TUI application. The valuable parts are the small, named contracts inside it (`turn-recovery.ts` is 2,876 lines of one decision; `coerceToolResult` is 70). Copying the shape gets you the coupling without the reasoning.

**Do not copy the flat `while` loop's 26-layer inner body** (`agent-loop.ts:1153-1734`, ~580 lines in one function). The individual guards are excellent; the nesting is the cost of adding them incrementally over years. August's loop should gain *named* guards, not a bigger function.

**Do not copy the KDL rule tree (P2-8) now.** It is a multi-week migration with a codegen step and a committed artifact, and it touches pricing, routing, and prompt assembly at once. The `AGENTS.md` rule against a second rate table is enforceable today without it.

**Do not copy the `xd://` device-dispatch surface.** It requires a second routing layer over every FS-shaped tool (`read xd://` lists devices, `write xd://<tool>` executes one). August's BM25 tool search gets most of the schema-reduction benefit with none of the second-path tool-authorization surface. The `loadMode` idea is worth taking; the transport is not.

**Do not copy `snapcompact`.** Printing transcripts onto PNG frames is a real, evaluated result for specific vision models on specific providers (`docs/compaction.md:198-205`), but it depends on a per-model frame-shape table and per-provider image-billing formulas. It is a research artifact, not a harness pattern.

**Do not copy the `bash` pattern-approval complexity verbatim.** `allowCompoundCommands` with flat-`&&` recognition, per-segment and whole-chain restriction combination, and a POSIX-shell classifier (`docs/approval-mode.md:49-58`) is ~6 pages of specification for one feature. August's `tool_policy.py` segment-aware splitting is already close; take the *shape*, not the full rule language, and do not let it grow into a second shell parser.

**Do not copy `interruptMode: "wait"` semantics** (`:2935-2938`) without reading the surrounding comment twice. The distinction — interruptible waits are *always* cut short, side-effecting work is only spared — is correct, but the four-signal construction (external / steering / irc / cooperative) is easy to get backwards. If in doubt, implement only the cooperative signal and the guarded poll.

**Do not assume `agent-session.ts`'s retry is in the loop.** It is not: retry classification and backoff live in `TurnRecovery` (`session/turn-recovery.ts`, 2,876 lines) and are checked from the `agent_end` path *before* compaction (`docs/non-compaction-retry-policy.md:18-28`). If you copy the retry policy without keeping it in a separate owner, overflow errors will start going down the retry path.

**Do not copy `modes/controllers/streaming-reveal.ts`'s 30 fps reveal without measuring.** The comment at `:24-27` says a full-tree walk at 30 fps costs 5% of CPU on its own and cascades to ~20%. In React the equivalent is a per-block subscription; without one, this feature will be a performance regression, not a UX improvement.

**Do not copy `isolation-ownership.ts`'s pid liveness on Windows.** The code documents the degradation (`:44-49`): Windows yields `null` and falls back to pid-only. August ships a Tauri **desktop** app where Windows is the primary platform, so a pid-only liveness check will pin crashed sandboxes live exactly as the comment warns. Use a file lock or a boot-id + start-time equivalent, or accept the leak and prune by age.

**Do not copy `main` in the settings scope without the invalid-file backup.** `docs/settings.md:48` — an unparseable persistent settings file is moved to a uniquely named `.broken-*` backup and the process exits with the original error. Skipping this turns a config typo into a silent reset-to-defaults, which is how people lose model assignments.

**Do not copy the `[... Tool result truncated at N KB]` free-text marker as a contract.** It is fine as a human hint. August should not parse it, and neither should oh-my-pi — which is exactly why it moved to a structured `OutputMeta` (`tools/output-meta.ts`) with `truncation`/`limits`/`diagnostics` metadata attached to the result. Adopt the metadata, not the string.

**Do not port `docs/compaction.md`'s remote-native compaction lanes (OpenAI V2 streaming, V1 `/responses/compact`, Anthropic `compact-2026-01-12` beta).** These depend on provider replay payloads, `providerReplayThroughEntryId` bookkeeping (`docs/compaction.md:245`, `:321`), and per-provider URL resolution rules that exclude rerouted endpoints. The transferable part is the *separation* of overflow / incomplete / threshold / idle triggers (`:109-139`), not the provider-specific lanes.
