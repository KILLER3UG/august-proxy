# Sub-Agent System Audit (Agent 3 of 6)

All repros below run against `backend-py/tests/test_audit_agent3_subagents.py` and
`backend-py/tests/test_audit_agent3_bugs.py` (worktree `C:/Dev/august-agent-3`,
branch `agent-audit-3-subagents`). Both files drive `executeSubAgent` /
`SubagentOrchestrator` with a scripted model caller (the pattern already used in
`backend-py/tests/test_subagent.py`) — no live LLM was needed to expose these.

## Bugs that make sub-agents unusable

### 1. 🔴 Recursion guard is dead — sub-agents can call `spawn_subagents` (plural), bypassing every depth/tool check

**File:** `backend-py/app/services/workbench/subagent.py:239` and `:420`

```python
allowedNames = {
    _toolName(t) for t in fullTools
    if _toolAllowed(agent, _toolName(t)) and _toolName(t) != 'spawn_subagent'
}
…
if not _toolAllowed(agent, tName) or tName == 'spawn_subagent':
    result = f"[Blocked] Sub-agent not permitted to use '{tName}'."
```

Both filters compare against the **singular** `'spawn_subagent'` only. The plural
`spawn_subagents` tool (the one whose system prompt says "Prefer this … when
investigating different areas at once") is registered alongside it
(`tool_registrations/agent_tools.py:398-437`) and is left in the sub-agent's
tool surface. The capabilities prompt even *tells* the model to use it:
`capabilities_prompt.py:323` — "or `spawn_subagents({workItems:[...]})` to launch
several in parallel".

The system prompt sternly says "Do not spawn further sub-agents"
(`workbench/subagent.py:258`) but that is purely advisory. Any sub-agent that
emits a `spawn_subagents` tool call gets through `executeSubAgent` and re-enters
the spawn machinery with a fully-capable tool surface.

**Repro:** the depth check is the second half of the bug — see #2 for proof it
never fires for the default 'general' agent.

### 2. 🔴 Depth cap is a no-op for every default sub-agent (`general`, `explore`, `plan`, `shell`)

**File:** `backend-py/app/services/workbench/subagent.py:60`, `:121-129`; `agent_registry.py:19`

```python
# _agentOrGeneral fallback when agent isn't persisted:
return { 'id': aid.lower() if aid.lower() in known else 'general',
         …, 'depth': 0, '_synthetic': True }
```

```python
depth = as_int(agent.get('depth', 0))
if depth >= _MAXAgentDepth:                    # _MAXAgentDepth = 4
    …blocked…
```

`agent['depth']` is the **persisted tree position** of the agent definition
(`agent_registry._calculateDepth`) — it is **not** incremented per invocation.
For the builtin synthetic roles the fallback hardcodes `depth=0`, and there is
no per-call depth counter passed down through `executeSubAgent`. Even for a
persisted agent tree, the depth only changes when an admin re-parents an agent
in `Agent settings` — never because a sub-agent is currently running inside
another sub-agent.

**Consequence (combined with #1):** a sub-agent calling `spawn_subagents` to
launch `general` again gets a fresh depth=0 child that itself can call
`spawn_subagents` again. This is unbounded recursion with only the
`MAX_CONCURRENT_WORKERS=5` semaphore and the `_managedToolLoopCap` of the inner
loop acting as de-facto brakes. Each iteration creates 5 new sub-agents,
each of which can spawn 5 more, and the slot-wait is 10 minutes
(`SLOT_ACQUIRE_TIMEOUT_SECONDS=600`). Effect: budget exhaustion, runaway
provider spend, and the user's main agent blocked behind the orchestrator.

**Repro:** `test_audit_agent3_bugs.py::test_depth_cap_only_blocks_persisted_agents_with_depth_4` —
asserts `_agentOrGeneral('general', …)['depth'] == 0` after the lookup, so
`0 < _MAXAgentDepth` is always true and the `blocked` branch is unreachable for
synthetic agents.

### 3. 🔴 No way to cancel a sub-agent from the chat UI where it actually appears

**Files:**
- `frontend/desktop/src/components/shell/RightDrawerSubagentsSection.tsx` — the live sub-agent roster (this is the surface users actually watch)
- `frontend/desktop/src/components/chat/SubagentTimeline.tsx`
- `frontend/desktop/src/components/chat/SubagentExpandedCard.tsx`
- `frontend/desktop/src/components/chat/SubagentLaunchList.tsx`
- `frontend/desktop/src/components/chat/SubagentRow.tsx`

`grep -rn "terminate\|cancel" frontend/desktop/src/components/chat/` returns
zero hits in any of the live rendering paths. The only places a user can press
"stop this sub-agent" are:

- `sections/brain/RunsTab.tsx` (Brain → Runs tab — a separate settings page)
- `sections/board/BoardPage.tsx` (Kanban board — a separate surface)
- `components/shell/TeamAgentsStrip.tsx` (also dead — see Other issues #5)

The right drawer (the surface users actually see live) and the chat-thread
launch list both lack any button. From the chat you can watch a sub-agent
spin forever and the only remedies are: stop the whole chat turn, or
sidebar → Brain → Runs.

**Repro (static):** read the components. `RightDrawerSubagentsSection.tsx` has
`Sparkles, X, CheckCircle2, CircleAlert, Loader2` icons — `X` only closes the
detail view (dismisses from the local openTaskIds list, which is a UI hide, not
a terminate). There is no invocation of `terminateSessionAgent` or
`subagents.terminate` anywhere in the chat-right-drawer code path. The API is
wired (`api/subagents.ts:55` exposes `terminate`), the endpoint exists
(`routers/subagent.py:134 POST /api/subagents/{taskId}/terminate`) — the UI
just doesn't call it from where the user is looking.

### 4. 🟠 `yieldSchema` schema mismatch returns `status='completed'` with the failure embedded in the payload

**File:** `backend-py/app/services/workbench/subagent.py:488-516`

```python
if yield_schema and finalText.strip():
    try:
        parsed = _json.loads(finalText.strip().strip('`'))
        if isinstance(parsed, dict):
            check = validateToolArguments(…)
            if as_bool(check.get('valid'), False):
                resultText = _json.dumps(parsed, ensure_ascii=False)
            else:
                resultText = (f'[yield validation failed: {…}]\n'
                              f'Raw answer:\n{finalText[:4000]}')
```

When validation fails (or the answer isn't JSON at all), the function still
returns `{'status': 'completed', 'result': '[yield validation failed: …]'}`.
The orchestrator's `_result_is_failure`
(`subagent_orchestrator.py:424-447`) looks for `status in ('failed', 'error',
'cancelled')` or empty payload — this status is `'completed'` and the payload
is a non-empty string, so the failure is **counted as success** in
`spawn_subagents`' blocking-mode tally (`succeeded += 1`) and reported to the
parent model as `Sub-agent 'X' completed. …`. The parent then has to parse a
human-readable `[yield validation failed: …]` string out of the result text
instead of getting a structured error.

**Repro:**
`test_audit_agent3_subagents.py::test_yieldSchema_invalid_json_returns_failure_text_not_raise`:

```
[yieldSchema-invalid-json] status='completed'
  result='[yield validation failed: answer was not valid JSON]\nRaw answer:\nI could not produce JSON. Hope that helps!'
  error=None
```

```python
[yieldSchema-wrong-shape] status='completed'
  result='[yield validation failed: Missing required field: \'answer\']\nRaw answer:\n{"wrong": 1}'
```

The fix has to be one of: (a) return `status='failed'` and let the
completion-notice surface the validation error as `error`, or (b) keep
`completed` but write `result=''` and `error='yield validation failed: …'` so
`_result_is_failure` returns True. Today neither happens.

### 5. 🟠 Empty-text sub-agent reports `completed` and bypasses the B27 empty-result guard

**File:** `backend-py/app/services/workbench/subagent.py:517-522`

```python
elif not resultText.strip():
    # …synthesize an honest summary instead of letting a clean run tally as failed.
    resultText = f'(Sub-agent completed after {toolRound} tool round(s) with no textual answer.)'
```

The comment claims the orchestrator would treat empty as failure (B27) so we
synthesize a non-empty string. But injecting "(no textual answer)" flips the
payload to non-empty, **defeating** `_result_is_failure`
(`subagent_orchestrator.py:439-443`):
`status == 'completed' and payload_text != ''` → returns False (not a failure).

So a sub-agent that models silently loop through tool calls without producing
any final answer, hits the loop cap, and exits — gets tallied as a successful
sub-agent completion and the parent receives a meaningless "(completed after
3 tool round(s) with no textual answer.)" string as the result. Multi-spawn
"succeeded" counters are inflated.

**Repro:**
`test_audit_agent3_bugs.py::test_completed_with_empty_text_marks_failed_in_orchestrator`:

```python
[synth-empty-is-failure] False   # i.e. the synthesized text is NOT a failure
```

and the natural-language variant in `test_audit_agent3_subagents.py`:

```
[loop-cap] status='completed'
  result='(Sub-agent completed after 3 tool round(s) with no textual answer.)'
[empty-text] status='completed'
  result='(Sub-agent completed after 1 tool round(s) with no textual answer.)'
```

Honest behavior would be `status='partial'` or `'failed'` with
`error='sub-agent produced no final text'`.

## Other issues

### 6. Cancellation is best-effort and racy near a hung model call

`subagent_orchestrator.py:224-238` — `terminate()` does `task.cancel()` then
`await task` and swallows `CancelledError`. That works only because
`executeSubAgent`'s provider call is wrapped in
`asyncio.wait_for(SUBAGENT_MODEL_TIMEOUT_S)` (`workbench/subagent.py:321,329`),
which makes the wait_for the cancellation point. Two slopes:

- The handle is set to `status='cancelled'` **before** the inner worker
  finishes unwinding. If any code inside the cancel path marks the job
  `failed` (e.g. `executeSubAgent`'s generic `except Exception` at
  `subagent.py:536-548` — which catches `CancelledError` on Python 3.11+
  because that inherits from `BaseException`, **not** Exception — so it's
  actually safe; but other generic exception paths could still write after
  the cancel), the final state can flip from `cancelled` to `failed`.
- `_record_run(handle)` is called synchronously after `task.cancel()` with
  the `'cancelled'` status, but then `_runWithSlot`'s
  `except asyncio.CancelledError` also calls `_record_run(handle)`. The DB
  row gets written twice — benign but wasteful, and the second write may
  race with the watcher's `_enqueue_completion`.

The bigger problem is: there is **no distinction between "user aborted" and
"sub-agent crashed"** in the completion notice (`_format_completion_notice`),
so the parent model sees `SUBAGENT_COMPLETE status="cancelled" goal:…` with no
hint that it shouldn't retry.

### 7. No recoverable proposals across restarts if backend is recycled mid-approval

`spawn_subagents_tool.py:172-210` (`_load_proposal_from_db`) does rehydrate a
pending proposal from the `proposals` table, and it does best-effort create a
synthetic `types.SimpleNamespace` session if the original session is gone.
However, `_doSpawn` then calls `orchestrator.spawn(request)` with
`request.session = SimpleNamespace(id=…, model='', agentId='', provider='')`.

`executeSubAgent` reads `session.model` (`subagent.py:119`) and
`session.provider` (`:175`) for routing. With both empty strings, the
`resolve_or_fallback('' …)` path falls through to the smol-role / fleet
routing. If no fleet model is configured, the approval-spawned sub-agents
silently land on `No provider available for sub-agent.` and fail. The
proposal was approved, the user got a toast "Proposal approved — agents
launched", and every agent immediately errors out.

Mitigation would be: read the active provider/model from `getConfig()` in
`_load_proposal_from_db` when rebuilding the session (mirroring what
`routers/agents.py:157-179` already does for API-created jobs).

### 8. `_enqueue_completion` triggers an auto-turn even when the user is no longer watching

`spawn_subagents_tool.py:307-328`. If the parent turn ended cleanly (e.g. the
user closed the chat / ended the session) but sub-agents are still running in
background, every `_enqueue_completion` calls `scheduleSubagentAutoTurn(sid)`
which fires up *another* LLM call to process `[SUBAGENT_COMPLETE …]`. With 5
sub-agents in background mode you get up to 5 follow-up auto-turns (coalesced,
but still) for a conversation the user has walked away from. There is no
"only if session has unacknowledged queue" check; the only check is that
`_enqueue_completion` drops when `sid == ''`.

### 9. `updateJob(jobId, {'status': 'failed', 'error': 'Job ended without a terminal status'})` will silently corrupt completed jobs

`routers/agents.py:226-242`. The "finally" sweep enumerates `listJobs()` and
flips any job still in `pending`/`running` to `failed`. If the underlying
job-store write for a just-finished job hasn't been flushed yet (or was on a
different connection), this sweep can find a stale `running` row and overwrite
a successful `completed` row with `failed: Job ended without a terminal
status`. The filter checks status of the in-memory list, not the freshly-read
row, so it's at least racy.

### 10. Dead UI code: `SubagentRow`, `SubagentLaunchList`, `SubagentExpandedCard`, `SubagentDetailModal` are not rendered anywhere

```
$ grep -rln "SubagentLaunchList\|SubagentRow" frontend/desktop/src/
  → only matches their own files + their own __tests__ files
```

The components were rebuilt into `RightDrawerSubagentsSection` +
`SubagentTimeline`, and the older standalone components were left behind.
They still compile (and their tests still pass), which gives the illusion
that there is a chat-thread launch UX when there isn't. This is also why the
cancel button feels missing — the buttons originally written for the dead
list never got ported to the live drawer.

### 11. Slot acquisition timeout is 10 minutes — too long to feel responsive

`subagent_orchestrator.py:52` `SLOT_ACQUIRE_TIMEOUT_SECONDS = 600`. When all 5
workers are running and the user spawns a 6th sub-agent (or a sub-agent
spawns via the unguarded `spawn_subagents` path — see #1), the 6th waits up to
10 minutes, then surfaces as
`"Timed out waiting for a worker slot (all sub-agent slots busy)."`. By that
point the user has long given up and pressed Stop on the parent turn, which
leaves the queued spawn orphaned (the parent turn is dead but the spawned
tasks keep running until their own loop caps hit).

### 12. Retry policy inheritance is a policy *template*, not a budget

`workbench/subagent.py:297` calls `_modelRetryPolicy()` which reads the same
global policy as the parent. There is no per-tree budget; an Anthropic
"father" that retries 3 times has a "son" that *also* retries 3 times per
model call, and the son's tool calls can loop 25 times, and each tool-loop
iterations calls the model up to 4 times — so a single outer turn can
multiply into `3 retry × 25 tool-rounds × N parallel sub-agents` provider
calls. With `MAX_CONCURRENT_WORKERS=5` and the (#1) unbounded recursion bug,
this is the cost-explosion vector.

### 13. `_emit` in `agent_tools._spawnSubagent` writes to event_log but drops the model when schema result is dict

`tool_registrations/agent_tools.py:227-232`:

```python
if isinstance(one.get('result'), dict):
    inner = one['result']
    text = (as_str(inner.get('result')) or as_str(inner.get('output'))
            or as_str(inner.get('error')) or text)
```

When `yieldSchema` validation succeeded, `result['result']` from the
orchestrator path is a JSON **string** (not a dict) — the `isinstance`
branch never fires and the raw JSON string is what reaches the model. That's
fine. But when the spawn tool is hit via the REST `/api/subagents/spawn` with
a `yieldSchema` work item, the wire-format differences (`agents.py` rebalances
`work_items` with `agentId`→`agentId`) mean some calls build differently
nested dicts. The dict-vs-string `result` shape isn't normalized anywhere.

### 14. `subagentStart` get emitted twice for `spawn_subagent` (singular) if `background=False`

`tool_registrations/agent_tools.py:_spawnSubagent` calls
`executeSpawnSubagents` with a 1-element `workItems`. The orchestrator emits
`subagentStart` once per handle in `_doSpawn` (`spawn_subagents_tool.py:464`),
then if `background=False` the loop emits `subagentDone` per completed handle
(`:514-522`). But before that, the `executeSubAgent` inside the worker also
emits its own `subagentStart`/`subagentDone` with the *worker's* `jobId`
(`subagent.py:165, :525`). The worker's `_combinedEmit` filters those out
except for `subagentText`/`subagentToolCall`/`subagentToolResult` — so
start/done appear once from the orchestrator pov. **However**, when the
sub-agent path is entered via `agents.py:184` (`executeSubAgent(...)` called
directly with `job_id=job_id`), the emits go straight through with the
job-registry `job_xxx` id, not an ORCH taskId. The UI then receives a
`subagentStart` for a `jobId` that no orchestrator handle ever matches —
`terminate(taskId)` 404s on it, and `listActive` never returns it. Result:
an API-launched sub-agent is visible in chat but cannot be cancelled through
the orchestrator.

## Suggested UI for launching sub-agents

Goal: one canonical surface where the user watches, steers, and cancels. The
chat-right-drawer (`RightDrawerSubagentsSection`) is the right place — the
current chat thread is too narrow for a roster, and Brain→Runs is too far
away.

### Components (proposal)

```
ChatRightDrawer
├── SubagentsSection (live roster)
│   ├── SubagentCard (per running agent)
│   │   ├── Header: role icon + goal (truncated) + status pill + elapsed
│   │   ├── LiveActivityFeed: last 3 events (text / tool call / tool result)
│   │   ├── Actions:
│   │   │   ├── [Stop]          → POST /api/subagents/{taskId}/terminate
│   │   │   ├── [Open detail]   → expands inline timeline
│   │   │   └── [Reassign model] → dropdown; onPick → PATCH …/agents/{taskId}/model
│   │   └── (on completion) ResultBlock: shows result/resultSummary inline,
│   │       with [Copy] and [Insert into chat] affordances
│   ├── Footer: [Stop all] → POST /sessions/{sessionId}/agents/cancel-all
│   └── EmptyState: "No sub-agents running. Launch one from composer with /agents."
│
└── ProposalsSection (when spawn_subagents used mode='proposed')
    └── ProposalCard: goal list + [Approve & launch] [Reject] buttons
        → POST /api/subagents/propose-breakdown
```

### States a card must render

| State | Visual | Action available |
|---|---|---|
| `pending` (queued for a slot) | grey dot + "queued" | Stop |
| `running` | spinner + elapsed + streaming feed | Stop |
| `completed` | green check + result block | Open result, Copy, Re-run |
| `failed` | red X + error message + retry | Stop is hidden; [Retry] re-invokes orchestrator |
| `cancelled` | grey stop icon + "cancelled by user" | Archive |
| `yield validation failed` | amber warning + "schema mismatch" pill, raw answer collapsed | Retry with same yieldSchema |

(The `yield validation failed` state needs backend support — today it's a
plain `completed` with a snippet of prose in the result. Fix #4 first.)

### Wiring the cancel button to where users actually look

1. Add a small red stop icon to every row in `RightDrawerSubagentsSection`
   (`RightDrawerSubagentsSection.tsx` line 232-249) — wire it to
   `subagents.terminate(taskId)` and reflect the state by invalidating the
   `['session-agents', workbenchSessionId]` query.
2. Add the same affordance to the inline `SubagentTimeline` header in the
   chat detail view (the one opened by clicking a row).
3. Add a "Stop all sub-agents" chip next to the chat composer while any of
   the active session's agents are `running` — one click →
   `cancelAllSessionAgents`.
4. Where `spawn_subagent(s)` is invoked from a user gesture (composer
   `/agents` palette or a new "Launch team" button near the model picker),
   pre-fill the orchestrator call with a sessionId, and immediately navigate
   the right drawer to the Subagents section.

### Progress UX

- The live feed inside a card should use `subagentText` / `subagentToolCall` /
  `subagentToolResult` events (which the SSE stream already delivers through
  `apply-subagent-event.ts`). The reducer works; the components just aren't
  wired into the drawer.
- Each card should also surface the *retry* state — show "retrying in Ns"
  when the model returns a 5xx. That data isn't currently emitted as an SSE
  event, so the orchestrator/worker should add a `subagentRetry` event with
  `{attempt, delayMs, errorStatus}`.

## Other improvements

- **Tighten the recursion guard.** Fix the tool filter at
  `workbench/subagent.py:239,420` to also exclude `'spawn_subagents'` (and
  consider a whole denylist: `spawn_subagent`, `spawn_subagents`,
  `create_agent`, `set_agent_mode`). Track invocation depth in a ContextVar
  (alongside `currentSessionId` and `currentToolUseId`) and refuse
  `executeSubAgent` when `>= _MAXAgentDepth` — the registry's `depth` field is
  a static tree-position, not a runtime counter. Until that lands, each
  sub-agent spawns with the full sub-agent surface and the depth check never
  fires for synthetic roles.
- **Standardize the status taxonomy.** The codebase mixes `{'completed',
  'partial', 'failed', 'cancelled', 'error', 'blocked', 'recovered'}`
  between `executeSubAgent`, `runSubagent`, the orchestrator's tally,
  `_result_is_failure`, the `_format_completion_notice` string-formatter,
  and the frontend `SubagentInfo['status']` union. Document one source of
  truth (suggest aligning on the wire literal in `SubagentInfo.status`) and
  map legacy variants at the edges.
- **Emit `subagentRetry` SSE.** Today retries are silent, so a sub-agent
  that's just slow looks identical to a sub-agent that's retrying a 503.
- **Drop or finish the dead UI.** `SubagentRow`, `SubagentLaunchList`,
  `SubagentExpandedCard`, `SubagentDetailModal`, `TeamAgentsStrip` are dead
  code. Either delete them or wire them in — but stop letting them drift.
- **Cap enqueue-auto-turn.** `scheduleSubagentAutoTurn` should skip when the
  session has been idle > N minutes or the chat tab is closed — otherwise
  background completions light up model spend for a tab the user no longer
  has open.
- **Document the proposal-db contract.** The `proposals` table is written
  with `proposal_type='subagent_breakdown'` and `content=JSON({proposalId,
  workItems, mode, background, sessionId})`. That shape is implicit in
  `spawn_subagents_tool.py` only — extract a typed interface and reuse it
  from the Brain RunsTab code (which currently re-parses raw JSON).
- **Test coverage for `_result_is_failure`** lives in
  `test_subagent_orchestrator_characterization.py` — extend it with the
  synthetic empty-result and yield-validation cases from this audit so the
  fix for #4/#5 is regression-locked.
