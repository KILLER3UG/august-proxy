# Sub-agent output audit — why output reaches neither the model nor the UI

**Scope:** `backend-py/app/services/subagent_orchestrator.py`, `subagent_worker.py`,
`tools/spawn_subagents_tool.py`, `workbench/subagent.py`, `routers/workbench.py`,
`routers/subagent.py`, `services/event_log.py`, and the matching
`frontend/desktop/src` SSE/reducer/render path.
**Method:** read-only static trace. No tests run, no app run, no existing file modified.
**Date:** 2026-09-24.

---

## 0. The path, end to end

| Stage | Where | Transport |
|---|---|---|
| 1. Model calls `spawn_subagents` | `backend-py/app/services/tool_registrations/agent_tools.py:135-171` (`_spawnSubagents`) | managed-tool dispatch |
| 2. Tool → orchestrator | `backend-py/app/services/tools/spawn_subagents_tool.py:368-421` (`executeSpawnSubagents`) → `_doSpawn:464` | — |
| 3. Dispatch workers | `backend-py/app/services/subagent_orchestrator.py:344-511` (`spawn`) | `asyncio.create_task` per work item, gated by a global `Semaphore(5)` + per-session semaphore |
| 4. Run one worker | `subagent_orchestrator.py:724-864` (`_runWithSlot`) → `subagent_worker.py:24-149` (`runSubagent`) → `workbench/subagent.py:238-1381` (`executeSubAgent`) | asyncio task, same event loop |
| 5. Live events | `subagent_worker.py:84-103` (`_combinedEmit`, filters + rewrites `jobId`→`taskId`) → `subagent_orchestrator.py:401-429` (`_wrapped_emit`, touches handle, appends delegation jsonl) → `agent_tools.py:157-161` (`_emit`) → `services/event_log.py:75-97` (`append`) | per-session in-memory ring (2000) + JSONL + `asyncio.Queue` fan-out |
| 6. Settle | `subagent_orchestrator.py:811-860` sets `handle.result`, calls `_record_run` (DB `subagent_runs`) and `_fireEvent` | — |
| 7. Back to the parent | `spawn_subagents_tool.py:630-668` — `waitForEach` → emit `subagentDone` + `_enqueue_completion` (background) or return `results` (foreground) | queue entry `kind='subagent'` |
| 8. Parent turn picks it up | `routers/workbench.py:215-240` (`scheduleSubagentAutoTurn`) → `183-212` (`_startSubagentAutoTurn`) → `_startTurnTask`; or in-loop drain at `workbench/workbench.py:3770` / `:4449` | new backend turn |
| 9. SSE to the client | `routers/workbench.py:474-489` (`/chat/stream`) over `event_log.subscribe` | SSE |
| 10. Client dispatch | `frontend/desktop/src/api/workbench/streamEvents.ts:31-482` (`dispatchWorkbenchEvent`) | — |
| 11. Client reducer | `frontend/desktop/src/sections/chat/stream/apply-subagent-event.ts:23-163` → `subagentBlocks` map | — |
| 12. Chat render | `frontend/desktop/src/sections/chat/message/AssistantBlockTimeline.tsx:620-695` → `components/chat/SubagentDelegateRow.tsx:38-118` | status row only |
| 12b. Drawer render | `frontend/desktop/src/components/shell/RightDrawerSubagentsSection.tsx:442-457, 594-625` | live blocks, else replayed jsonl, else `subagent_runs.result_full` |

The defects below are all breaks in this chain. Several are independent, so a single
fix will not make the symptom go away — that matches "it happens often".

---

## 1. Ranked defect list

### P0-1 — A worker's non-`completed` result text is thrown away before anyone can see it

**File:line**
- `backend-py/app/services/subagent_worker.py:143-146`
- `backend-py/app/services/workbench/subagent.py:1234-1256` (loop-cap path, produces the text)
- `backend-py/app/services/subagent_worker.py:93-98` (`_combinedEmit` drops the worker's own `subagentDone`)
- `backend-py/app/services/subagent_orchestrator.py:113-126` (`_record_run` then has nothing to persist)

**Mechanism.** `runSubagent` does
`if status != 'completed': return await _failAndBroadcast(subResult.get('error'))`.
`executeSubAgent` returns `{'status': 'partial', 'error': capErr, 'result': capResult}`
when the managed-tool round cap trips with text (`subagent.py:1256`), and
`capResult` is `f'{capErr}\n{finalText}'` — the worker's entire accumulated answer.
`runSubagent` keeps only the error string, so the orchestrator's `handle.result`
becomes `{'status': 'failed', 'error': '[loop cap reached] …'}` with no `result` key.
From there:
- `_doneResultText` (`spawn_subagents_tool.py:447-461`) returns `''` → the `subagentDone`
  SSE carries an empty `result`;
- `_record_run` computes `summary` from `result`/`output`/`summary` keys, all absent
  → `subagent_runs.result_full` is written as `''`;
- `_format_completion_notice` renders `'(empty result)'` for the parent model.

The one place that *did* carry the text — `executeSubAgent`'s own
`emit({'type': 'subagentDone', 'result': capResult[:4000]})` at `subagent.py:1241-1252` —
is filtered out by `_combinedEmit`, whose allow-list (`subagent_worker.py:94-98`)
contains only `subagentText | subagentToolCall | subagentToolResult | subagentTodos |
subagentRetry | subagentWarning`.

**Repro.** `spawn_subagents` with one `maxIterations: 5` work item against a goal that
needs more than 5 tool rounds. The worker writes its findings, hits the cap, and the
parent model receives only `[SUBAGENT_COMPLETE … status="failed"] [loop cap reached]
tool round limit 5 exceeded` with no findings. The drawer tab is empty but for that
error line, because `result_full` is `''`.

**Fix.** In `runSubagent`, carry `subResult['result']` through on the failure path —
return `{'taskId', 'agentId', 'status': status, 'error': err, 'result': as_str(subResult.get('result'), '')}`
— and teach `_result_is_failure` / `_record_run` / `_format_completion_notice` to read
`result` on non-success dicts. Add `'subagentDone'` to the `_combinedEmit` allow-list
(or delete the worker's own `subagentDone` emits, but not both).

---

### P0-2 — The background-completion auto-turn is single-shot: a completion that lands while the parent turn is still live is never re-scheduled

**File:line**
- `backend-py/app/routers/workbench.py:183-188` (the `return` on a live turn)
- `backend-py/app/routers/workbench.py:215-240` (`scheduleSubagentAutoTurn` — one wake, no re-arm)
- `backend-py/app/services/tools/spawn_subagents_tool.py:344-365` (`_enqueue_completion`)

**Mechanism.** Every background completion calls `enqueueUserMessage(kind='subagent')`
then `scheduleSubagentAutoTurn(sid)`. `scheduleSubagentAutoTurn` dedupes onto a single
1.5 s wake task; when the wake fires, `_startSubagentAutoTurn` returns immediately if
`_activeStreams[sessionId]` is still live, on the assumption that "its next loop boundary
drains the queue". The parent loop only drains at the *top* of a tool round
(`workbench.py:3770`, guarded by `toolRound > 1`) and once after a text round
(`workbench.py:4449`). A completion enqueued after that final drain — while the turn is
still persisting, running a length-continuation, or flushing durability — has no further
boundary. The wake is consumed, nothing re-arms it, and the completion sits in
`queuedUserMessages` until the user's *next* message. The parent model never sees it.

**Repro.** Background spawn of 3 agents. Agent A finishes at t=0 and the parent turn is
still streaming its answer. Agent A's notice is queued at t=0; the parent's final drain
already happened at t=-0.1 s; the wake fires at t=1.5 s while the turn is still live →
early return. Agent A's output never enters the model's context for this turn, and the
UI shows only the status chip flipping to `completed`.

**Fix.** Make the auto-turn a state machine rather than a one-shot: when a live turn
blocks the start, record a pending flag and re-check it in `safeStream`'s `finally`
(`routers/workbench.py:141-152`), or have `scheduleSubagentAutoTurn` retry on a bounded
backoff while `kind='subagent'` entries remain queued. Also drain with
`kinds={'subagent','daemon'}` at the *end* of `sendWorkbenchMessageStream` so a turn can
never exit with pending subagent notices.

---

### P0-3 — A run that is more than 4 auto-turns deep silently stops delivering every later completion

**File:line**
- `backend-py/app/routers/workbench.py:179` (`_AUTO_TURN_MAX_CONSECUTIVE = 4`)
- `backend-py/app/routers/workbench.py:191-194` (counter check and increment)
- `backend-py/app/routers/workbench.py:441` (the only reset — a real `POST /chat` with a message)

**Mechanism.** `_startSubagentAutoTurn` increments `session._autoTurnsSinceUser` and
refuses to start once it reaches 4. The counter is reset *only* by a user-originated
`POST /api/workbench/chat` that carries a message. A long orchestrator session — the
exact scenario that produces many subagents — therefore has its 5th, 6th, … completions
dropped on the floor. The counter is also incremented *before* the queue drain, so a wake
that finds nothing queued still burns budget. And the queue itself is hard-capped at 50
entries with drop-oldest (`workbench.py:2239-2249`), so a burst eventually evicts the
oldest completion notices too.

**Repro.** A five-wave DAG (`dependsOn` chain) in one session with no user message in
between. Waves 1-4 deliver; wave 5's completion notice is enqueued, the auto-turn
refuses, and the parent model's answer omits the final wave entirely.

**Fix.** Don't cap delivery — cap *concurrency*, not the number of deliveries. Track a
per-session pending-delivery flag; if `queuedUserMessages` still holds a `kind='subagent'`
entry, always start the turn. Move the increment to after a successful drain, and reset
it when the queue empties rather than on user input.

---

### P0-4 — Sub-agent output text has no render path in the chat transcript at all

**File:line**
- `frontend/desktop/src/sections/chat/message/AssistantBlockTimeline.tsx:620-695`
- `frontend/desktop/src/components/chat/SubagentDelegateRow.tsx:13-45, 72-116`
- contrast: `frontend/desktop/src/components/chat/SubagentTimeline.tsx` (the drawer *does* render blocks)

**Mechanism.** The sub-agent block's inner `blocks` array (text, tool calls, tool
results, `finalOutput` — built by `apply-subagent-event.ts:88-159`) is carried all the
way into the render layer and then thrown away: `AssistantBlockTimeline` filters
`subagentBlocks` to `{jobId, agentId, task, status, startedAt, finishedAt, workstream}`
and hands that to `SubagentDelegateRow`, which renders a one-line button with a spinner
and a `Failed`/`Cancelled` chip. There is no branch anywhere that mounts
`SubagentTimeline` from a live chat block. So even in the perfectly healthy live path the
worker's answer is invisible in the conversation — it only exists in the right drawer,
behind a click.

**Repro.** Spawn one subagent, let it finish, stay in the chat. The transcript shows
`SubAgent  General · <goal>` with a duration. The actual answer text appears nowhere in
the thread.

**Fix.** Give `SubagentDelegateRow` an expandable body that mounts `SubagentTimeline` with
`state={block}` (the data is already there), defaulting to collapsed while running and
expanded on `subagentDone` when the result is non-empty. Reuse the existing
`splitSubagentBlocks` + `SubagentTimeline` composition rather than writing a second renderer.

---

### P1-5 — `applySubagentEvent` silently drops every event for a jobId it has no block for, and `lastSeq` is persisted so the drop is permanent

**File:line**
- `frontend/desktop/src/sections/chat/stream/apply-subagent-event.ts:27, 63, 118`
- `frontend/desktop/src/sections/chat/stream/session-subscriber.ts:55-58, 90, 120-125`
- `frontend/desktop/src/sections/chat/stream/session-stream-store.ts:211, 264`
- backend producer: `backend-py/app/routers/workbench.py:483` (SSE breaks on `done`)

**Mechanism.** `subagentBlocks` is a pure in-memory `Map` — `emptyStreamState` and
`getOrInitSessionStreamState` both construct `new Map()`; nothing hydrates it from the
persisted transcript or from `subagent_runs`. The SSE cursor, by contrast, *is* persisted
to `localStorage` (`writeLastSeq`). So after a page reload, a session switch that LRU-evicts
the state, or any window where the `subagentStart` frame is missed, the store has no block
for that `jobId` and `applySubagentEvent` returns without mutating (line 63 for `subagentDone`,
line 118 for text/tool frames) — while the durable subscriber's `onSeq` has already advanced
`lastSeq` past those events, so the reconnect never replays them. The drawer's live block
is gone and only the 10 s `/api/subagents/runs` poll restores the stub row.

A second trigger needs no reload at all: the server's `generate()` breaks the SSE
connection on `done|error|aborted` (`routers/workbench.py:483`), and the durable
subscriber detaches on `onDone` / `onStarted` (`session-subscriber.ts:126-137`). The
per-turn consumer that replaces it is only attached by the 5 s `/chat/active` poller
(`store/chat-active-streams.ts:75-88`) or a focus event. Every `subagent*` frame in that
gap that arrives with no matching block is discarded, and `lastSeq` moves on.

**Repro.** Start a background spawn, then reload the app window (or switch to another
chat and back while the LRU evicts the stream state) before the workers finish. The
workers complete; the drawer shows a status row fetched from the DB, and the chat shows
nothing new. The live text was never re-delivered.

**Fix.** (a) Make `applySubagentEvent` synthesize a placeholder block on any
`subagentText|ToolCall|ToolResult|Done` for an unknown `jobId` instead of returning `{}`
— a late `subagentDone` must still create and render its result. (b) Either persist
`subagentBlocks` alongside `lastSeq`, or make the SSE cursor advance only over events the
reducer actually applied *and* have the reducer tolerate a start-less stream. (c) Keep
the durable subscriber attached across `done` when running subagents exist (the
`hasRunningSubagents` re-attach in `finally` at `session-subscriber.ts:280-286` only fires
when the store still has a `status === 'running'` block, which is exactly what P1-5
destroys).

---

### P1-6 — The persisted work-transcript replay filter never matches the persisted event names

**File:line**
- `frontend/desktop/src/components/shell/RightDrawerSubagentsSection.tsx:144-152` (`REPLAY_TYPES`)
- `:155-163` (`transcriptToBlocks`)
- `:594-611` (the `replayBlocks.length > 0` branch)
- producer: `backend-py/app/services/subagent_orchestrator.py:419, 421, 479, 780` writing
  `subagentText | subagentToolCall | subagentToolResult | subagentTodos | subagentRetry |
  subagentWarning | subagentStart | subagentRunning`
- `backend-py/app/services/subagent_worker.py:93-102` (the `subagent*` rename that broke it)

**Mechanism.** The comment on `REPLAY_TYPES` says "the workbench emit dicts use the same
camelCase types the live SSE path feeds `appendBlockEvent`". That stopped being true when
`_combinedEmit` began renaming the forwarded events to `subagentText` / `subagentToolCall` /
`subagentToolResult` (and rewriting `jobId` → `taskId`). Every event in the delegation jsonl
is therefore skipped by the filter, so `transcriptToBlocks` returns `[]` for every settled
run. The `run?.resultText` fallback at line 611 does still fire (the branch is
`replayBlocks.length > 0`), so the *final answer* survives — but the entire tool-call,
thinking, and streaming history of the worker is permanently unrenderable after a reload.

**Repro.** Let a sub-agent finish, reload the app, click its row in the drawer. You get
the final answer as markdown and nothing else — no terminal output, no file reads, no
thought trace, unlike the live view.

**Fix.** Add the `subagent*` names to `REPLAY_TYPES` and map them to `MessageBlock` shapes
in `transcriptToBlocks` (`subagentText` → `text`, `subagentToolCall` → `toolCall`,
`subagentToolResult` → `toolResult`, `subagentWarning` → `error`), or normalise the names
once in `_read_transcript` on the server so the persisted contract is stable. Better:
have `_append_transcript` write the *pre-rename* event names plus a `taskId` field, so the
persisted format is a stable contract independent of the SSE wire format.

---

### P1-7 — The proposed-breakdown approval path spawns with `emit=None`: zero SSE, nothing in the UI

**File:line**
- `backend-py/app/services/tools/spawn_subagents_tool.py:438-444` (`approveProposal` → `_doSpawn(..., emit=None, ...)`)
- `backend-py/app/services/tools/spawn_subagents_tool.py:549-556` (`_emit_starts` no-ops without `emit`)
- `backend-py/app/routers/subagent.py:398-410` (the HTTP approval entry, same call)

**Mechanism.** `executeSpawnSubagents(mode='proposed')` returns `awaiting_approval` and
persists the work items. When the user approves, `approveProposal` calls `_doSpawn` with
`emit=None`. Every downstream emit is guarded on `if emit`, so the approved dispatch
produces no `subagentStart`, no `subagentText`, no `subagentToolCall`, no `subagentDone` —
the user clicks "Launch" and the app goes silent. The workers do run and do persist to
`subagent_runs` and the delegation jsonl, so the output is recoverable in the drawer's
Runs tab, but nothing appears live and the parent model's completion notice is the only
in-band signal.

**Repro.** `spawn_subagents({mode: 'proposed', workItems: [...]})`, approve via
`POST /api/subagents/propose-breakdown`. No sub-agent block appears in the chat; the work
is invisible until you open the drawer and pick the run by hand.

**Fix.** Reconstruct the emitter in `approveProposal` the same way `routers/subagent.py:398`
does — `event_log.event_log.append(sessionId, ev['type'], ev)` — and read the session id
from `proposal['session']`. Better still, persist the emit target on the proposal row so a
backend restart can re-attach the same way `_load_proposal_from_db` rehydrates the session.

---

### P1-8 — Stopping the turn during a foreground (`background=false`) spawn discards every result

**File:line**
- `backend-py/app/services/tools/spawn_subagents_tool.py:667-668` (`if background: _enqueue_completion(...)`)
- `backend-py/app/services/tools/spawn_subagents_tool.py:715` (`results = await _run_all_waves()`)
- `backend-py/app/services/tools/subagent_orchestrator.py:848-852` (cancel re-raises)

**Mechanism.** With `background=false` the results are returned only as the tool's return
value, and `_enqueue_completion` is *not* called. If the user presses Stop (or the turn is
aborted) while `_run_all_waves` is awaiting `waitForEach`, the awaiting coroutine is
cancelled. The already-spawned worker tasks are independent `asyncio.Task`s, so they keep
running and keep persisting — but nothing ever collects their handles, no `subagentDone` is
emitted, and no completion notice is queued. The parent model gets the cancellation, not the
work.

**Repro.** `spawn_subagents({workItems: [5 items], background: false})`, then hit Stop after
~10 s. The workers finish minutes later; the chat shows the spawn tool as interrupted and
nothing else.

**Fix.** Register the wave collector in `_session_watch_tasks` (the same set `cancel_session_watches`
already drains, `spawn_subagents_tool.py:61-75`) even in foreground mode, and in its
`CancelledError` handler drain whatever has already settled and `_enqueue_completion` it.
Alternatively always enqueue completions and have the foreground path additionally return
the aggregated dict.

---

### P1-9 — The event-log ring evicts `subagentStart` long before `subagentDone`, orphaning the output

**File:line**
- `backend-py/app/services/event_log.py:41` (`MAX_IN_MEMORY = 2000`)
- `backend-py/app/services/event_log.py:80-82` (left-eviction)
- `backend-py/app/services/event_log.py:204, 221-229` (`deque(maxlen=…)`, rehydrate tail only)
- `backend-py/app/services/event_log.py:99-110` (`_QUEUE_MAX` persistence drops)

**Mechanism.** A chatty worker emits one `subagentText` frame per streamed delta plus a
frame per tool call and result. Five concurrent workers on a long tool-heavy goal produce
well over 2000 frames in a session, and the parent turn's own text/thinking frames share
the same ring. Once the `subagentStart` frame is left-evicted, any client that connects or
reconnects with a `sinceSeq` older than that point never receives it — it only gets the
`subagentDone`. Per P1-5 that done is then dropped for want of a block. A backend restart
has the same effect: `_SessionLog._rehydrate` loads only the last 2000 lines.

**Repro.** A five-agent batch on a big repo, then reload the app. The completions arrive;
the drawer shows DB rows; the chat shows no sub-agent blocks for the workers whose start
frames fell off the ring.

**Fix.** Don't stream raw text deltas into the shared session ring. Buffer worker text on
the handle and publish a coalesced `subagentText` (e.g. ≤1/s, like `_wrapped_emit`'s
`_record_run` throttle at `subagent_orchestrator.py:412-418`), or give `subagentStart` a
durable anchor the reducer can re-fetch (`/api/subagents/active` already carries it). Also
make the reducer start-tolerant (P1-5a), which makes eviction harmless.

---

### P2-10 — `subagentTodos` is emitted, persisted, and never dispatched by the frontend

**File:line**
- emit: `backend-py/app/services/workbench/workbench.py:6655-6672` (`routeTodos`, sub-agent branch)
- forward: `backend-py/app/services/subagent_worker.py:93-98`
- **no consumer**: `frontend/desktop/src/api/workbench/streamEvents.ts:40-482` (the switch has no `subagentTodos` case and no `default:`)
- schema accepts it: `frontend/desktop/src/api/schemas/workbench.ts:318`

**Mechanism.** The worker's `submit_todos` / `update_todos` land on its orchestrator handle
(`routeTodos` → `getHandle(currentSubagentTaskId)`), which is good, and a `subagentTodos`
frame is emitted. The client-side dispatcher has no case for it, so the `switch` falls
through and the event is dropped. It is also written into the delegation jsonl and
therefore dropped again by `REPLAY_TYPES` (P1-6). The per-agent progress chip in the drawer
only picks it up via the 10 s `/api/subagents/runs` poll of `todos_json`.

**Repro.** Give a work item a multi-step goal and watch its todo list live. The list never
appears; the `Progress n/m` chip in the drawer updates at most every 10 s, and only after
the run settles (`markDirty`/`record_lane` timing aside, `todos_json` is written by
`_record_run`, which is throttled to ~1/s during the run).

**Fix.** Add `case 'subagentTodos'` to `dispatchWorkbenchEvent` and a `onSubagentTodos`
handler that writes into the matching `SubagentBlockState`; add `subagentTodos` to
`REPLAY_TYPES` with a block mapping.

---

### P2-11 — Skipped workstream lanes emit a `subagentDone` with an empty `jobId` and are never enqueued

**File:line**
- `backend-py/app/services/tools/spawn_subagents_tool.py:585-613` (the skip branch)
- `backend-py/app/services/tools/spawn_subagents_tool.py:667-668` (`_enqueue_completion` only inside the settle loop)
- `frontend/desktop/src/api/workbench/streamEvents.ts:209` (`JSON.stringify('')` → the two-character string `""`)

**Mechanism.** A lane whose dependency failed is appended to `all_results` and emits
`{'type': 'subagentDone', 'jobId': '', 'status': 'skipped', 'message': …}` — but it never
reaches `_enqueue_completion`, so the parent model is never told the lane was skipped. The
SSE frame is also useless: `streamEvents.ts:209` coerces the missing `jobId` to the literal
string `'""'`, which is truthy, so `onSubagentDone` fires with a garbage key and
`apply-subagent-event.ts:63` drops it for want of a block.

**Repro.** Spawn a three-node DAG where node A fails. The parent model is told about A's
failure but never that B and C were skipped; the UI shows no skipped row for them.

**Fix.** Route skipped lanes through the same `_enqueue_completion` / emit path as settled
ones, giving them a stable `taskId` (allocate a handle at plan time, as the depth-rejected
path already does at `subagent_orchestrator.py:458-471`) so the UI can render the row.

---

### P2-12 — `POST /api/subagents/spawn` without an `X-Session-Id` header drops every completion

**File:line**
- `backend-py/app/routers/subagent.py:69-89` (`_getSession`, `id` defaults to `'default'`)
- `backend-py/app/services/tools/spawn_subagents_tool.py:344-355` (`_enqueue_completion`, return value discarded)
- `backend-py/app/services/workbench/workbench.py:2211-2216` (`enqueueUserMessage` returns `None`)

**Mechanism.** Without the header the run binds to session `'default'`. On completion
`_enqueue_completion` calls `enqueueUserMessage('default', …)`, which returns `None` because
no such workbench session exists; the return value is not checked, and
`scheduleSubagentAutoTurn('default')` then no-ops in `_startSubagentAutoTurn` (line 186-188).
The workers run, persist, and emit SSE into a `'default'` event log that no client is
subscribed to. Nothing anywhere reports the failure.

**Repro.** `curl -X POST localhost:PORT/api/subagents/spawn -d '{"work_items":[{"goal":"..."}],"mode":"auto","background":true}'`
with no `X-Session-Id`. The runs appear in the global Runs tab; the parent never hears about them.

**Fix.** Reject the request with a 400 when no session id can be resolved (the frontend
already sends the header — see the docstring at `frontend/desktop/src/api/subagents.ts:66-70`),
and make `_enqueue_completion` log at warning level when `enqueueUserMessage` returns `None`
instead of `logger.debug`.

---

### P2-13 — `emit=None` on the unattended and MCP spawn paths: no UI at all

**File:line**
- `backend-py/app/services/harness_ops.py:241` (scheduled routines, `emit=None`)
- `backend-py/app/routers/harness_mcp.py:118-124` (`harness_spawn` / `harness_continue`, `emit` defaulted to `None`)
- `backend-py/app/services/harness_mcp.py:110-113` (session shell has `model=''` and no `workspacePath`)

**Mechanism.** Both paths dispatch real workers through the same orchestrator with no
emitter, so the same silent-run symptom as P1-7 applies. On the MCP path it is worse: the
`SimpleNamespace` session has no `model` and no `workspacePath`, so `resolve_or_fallback('')`
often yields no provider and every worker returns `'No provider available for sub-agent.'`
— a failure the user has no way to see, because nothing is emitted.

**Repro.** Fire a scheduled harness routine, or drive `harness_spawn` over MCP for a session
whose model is only set on the workbench session object. Nothing renders anywhere.

**Fix.** Thread the real session (or at least `model`/`provider`/`workspacePath` plus a
`_makeEmit(sessionId)` emitter) through both call sites. For the MCP path, hydrate from
`get_workbench_session(session_id)` with a `SimpleNamespace` fallback, as
`_load_proposal_from_db` already does at `spawn_subagents_tool.py:216-237`.

---

### P2-14 — The durable subscriber's `lastSeq` filter is per-event, so an interleaved rendered frame skips the turn frames before it

**File:line**
- `frontend/desktop/src/sections/chat/stream/session-subscriber.ts:102-125`
- comment at `:96-101` states the intent; `:120-125` implements it per-event

**Mechanism.** `onSeq` advances `lastSeq` to `seq` for any event in
`RENDERED_EVENT_TYPES`. The sequence is monotonic, so a rendered `subagentText` at seq 101
jumps the cursor past an unrendered `text` at seq 100. The per-turn consumer resumes from
`lastSeq` and never replays 100. The comment's stated invariant ("advancing lastSeq past
those events would make the per-turn reconnect skip them") is only true when no rendered
frame ever follows an unrendered one in the same attach window — which the detach-on-`started`
race (P1-5) makes unreliable.

**Repro.** The backend auto-turn fires while the durable subscriber is attached; a
`subagentDone` lands between the `started` frame and the detach; the per-turn consumer
reconnects from the advanced cursor and the assistant's first text delta is missing.

**Fix.** Track two cursors — `lastRenderedSeq` for the subscriber's own decisions and a
separate `resumeSeq` that is only advanced past a contiguous run of events the subscriber
actually handled. Simplest correct version: advance the persisted cursor only on
`done`/`aborted`/`error`, never mid-turn.

---

## 2. Non-findings (checked, clean)

- **SQLite contention.** `memory_conn.conn()` is thread-local
  (`backend-py/app/services/memory_conn.py:23, 112-122`) and every sub-agent worker is an
  asyncio task on the single event-loop thread, so `_record_run`'s
  SELECT-then-UPDATE-then-`commit()` (`subagent_orchestrator.py:101-206`) is serialised by
  construction. Rows are keyed by the unique `task_id`. The per-emit `_record_run` is
  already throttled to ~1/s per handle (`subagent_orchestrator.py:412-418`). No lock defect.
- **ContextVar depth/tool-use races.** `currentSubagentDepth`, `currentSubagentTaskId`,
  `currentSessionId`, and `currentToolUseId` are set and reset around `executeSubAgent`
  (`workbench/subagent.py:323-329, 667-675, 1373-1379`) and `_executeTool`
  (`workbench.py:5627-5628, 5794`). `asyncio.create_task` copies the context, so parallel
  workers do not cross-talk. `parallel_tools.PARALLEL_SAFE_TOOLS` includes
  `spawn_subagents` but `is_parallel_safe` has no call site in the tool loop, so the
  parallel path is currently dormant config, not a live race.
- **Handle pruning.** `_MAX_RETAINED_HANDLES = 12` finished handles per session
  (`subagent_orchestrator.py:51, 546-563`) only affects the in-memory roster; the durable
  `subagent_runs` rows and the delegation jsonl survive, so this is a roster-completeness
  issue, not an output-loss one.
- **The message bus.** `subagent_worker.py:79-83` documents that the
  `task:{id}:{progress|result|failure}` topics are dead letters with no subscribers. This
  is accurate — results travel by return value and by `handle`, not the bus — so the bus
  is not a loss path.
- **`waitForEach` correctness.** `subagent_orchestrator.py:594-614` handles already-done
  futures, `None` futures (the depth-rejected handles), and `FIRST_COMPLETED` correctly;
  cancelled tasks surface through `asyncio.wait` as done rather than raised, so a user
  interrupt still reaches the parent via `terminate`'s partial-result capture
  (`:695-722`).

---

## 3. Proposed fix order

1. **P0-1** (`subagent_worker.py:143-146`) — smallest change, largest recovery. One
   function; makes every truncated/failed run's text reach the model, the SSE, and the DB.
   Do this first because P0-2 and P0-3 currently have nothing to deliver.
2. **P0-2 + P0-3 together** (`routers/workbench.py:183-240`) — both are "the completion was
   queued but nobody ever turned it into a model turn". Replace the one-shot wake with a
   pending-delivery flag drained in `safeStream`'s `finally`, and delete the
   consecutive-turn cap in favour of a per-session "queue has subagent entries" predicate.
3. **P1-5(a)** (`apply-subagent-event.ts:63, 118`) — make the reducer synthesize a block for
   an unknown `jobId`. Three lines, and it converts every orphaning trigger (reload, session
   switch, ring eviction, subscriber-detach gap) from silent loss into a rendered result.
4. **P1-6 + P2-10 together** (the two name-set mismatches) — pick one canonical persisted
   event vocabulary. Renaming in `_combinedEmit` broke the replay contract; freeze it in
   `_append_transcript` and derive both `REPLAY_TYPES` and the SSE dispatcher from the same
   list so they cannot drift again.
5. **P0-4** (`AssistantBlockTimeline` / `SubagentDelegateRow`) — mount the already-present
   block data. This is the change that makes the complaint visibly stop; it depends on 1-4
   so there is real content to show.
6. **P1-7 + P2-13** (the `emit=None` spawn paths) — one shared helper that builds the
   session's event-log emitter, used by `approveProposal`, `harness_ops`, and
   `harness_mcp`. Mechanical.
7. **P1-8** (foreground + Stop) — register the wave collector in `_session_watch_tasks` and
   drain on cancel.
8. **P1-9** (ring pressure) — coalesce `subagentText` to ~1/s on the emit path, matching the
   existing `_record_run` throttle. Largely moot once 3 lands.
9. **P2-11, P2-12, P2-14** — correctness tidy-ups; do them with the code they touch.

**Do not** add a second result store or a second rate/limit table. `subagent_runs`
(`_record_run`) and the delegation jsonl (`_append_transcript`) are already the durable
layer; the defects above are all *read-path* breaks against data that is already written.
