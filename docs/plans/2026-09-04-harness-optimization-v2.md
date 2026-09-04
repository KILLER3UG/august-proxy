# Harness Optimization Plan v2 (2026-09-04) — consolidated round-2 scan

**Status: PARTIALLY IMPLEMENTED (2026-09-04) — validated 2026-09-04: backend 2302 passed /
0 failed, frontend 985/985, naming + doc-links + version-sync gates green, eslint 0 errors
(254-warning ratchet). All P0/P1 items landed in commits
`bd0cb732` (Wave 1: 3.1/3.2/3.3/2.1/2.2/3.5 + 1.5/1.6), `abe4a642` (Wave 2: 1.1/1.2/1.4),
`b58ede02` (Wave 3: 6.1/6.2/6.3/6.5/5.1), `e1f5d9c2` (Wave 4: 7.1/7.2/7.3), `39aa3002`
(Wave 5: 5.2 /safe + 4.2), `2f609dfc` (Wave 6: 7.4 memo + 3.10 queue), `324e1a40`
(Wave 7: 9.1/9.2/9.4). Remaining: Phase 10, the 6.4 learning-scope migration, 6.9 import
track, 1.3 Responses support, 4.1 bridge approval, 4.3-4.5 sandbox/MCP/PTY batch, the
remainder of 2.3-2.5/3.7/6.6-6.8 tuning items, and the npm/dependency cleanup (9.3).**

Method: two independent round-2 scans, merged into this one plan. **Scan A** — five parallel
deep-scan audits (model/provider wire path · multi-session & multi-subagent concurrency ·
memory/skills/learning end-to-end · frontend & FE↔BE contract · post-purge dead-code/config/CI),
every P0/P1 re-verified at line level afterwards, two memory findings reproduced live against a
scratch brain DB. **Scan B** — four fresh subagent passes focused on the core loop, turn
accounting, tools/sandbox/MCP, and the memory-import track. Merged 2026-09-04; overlaps deduped,
conflicts resolved (noted inline). Items marked **†** come from Scan B and were not line-re-verified
during the merge — treat their file:line as reported by that pass. Baseline: full backend pytest
suite green at scan time.

Related: `2026-09-04-harness-optimization.md` (v1, tree `eb084dec` — **landed** as Part 25,
commits `6ce693a4..90de0a21`; its findings are excluded here), `2026-08-30-harness-performance.md`.
This plan is written against tree `90de0a21`.

Severity: **P0** = correctness/data-loss · **P1** = race/leak/500-class · **P2** = perf/waste ·
**P3** = hygiene.

---

## 0. Ground truths & answers in brief

### 0.A The three scan questions

**Why do some models always return `[500]` while other harnesses work with the same model+provider?**
The 500 is upstream-relayed (`providers/clients/base.py:581-589`) and the workbench retries the
**byte-identical body** 3× (`workbench.py:252-274,3459`) then surfaces it. Three August-side
aggravators, all verified: (1) the OpenAI-format path sends the **entire 132-tool registry
(~81 KB, ≈20k tokens)** to any model without a capability profile — the budgeted
`assembleToolDefs` progressive disclosure exists only on the Anthropic builder
(`workbench.py:1663-1684` vs `:1810-1886`); other harnesses send a few-KB body; (2) the Test
button sends `tools=[]` (`routers/providers.py:744-771`) — the reported asymmetry; (3)
**Responses-format models are misrouted to `/chat/completions`** (0.B-2). **Retry-without-tools
does not exist anywhere** (grep-verified).

**Multiple sessions at once?** Capacity is generous (one asyncio task per session, unlimited
streams, 60-session recency window with live-turn prune guard, single WAL writer). Gaps: the
one-turn-per-session invariant lives only in the HTTP router — unattended callers (Bot DMs, rooms,
routines, Live) bypass it (3.1/3.2); barrier flushes DELETE+re-INSERT the whole transcript on the
event loop (3.4); mutating routes (undo/truncate/checkpoint-restore) race live turns (3.3).

**Multiple subagents?** Architecture sound (per-session semaphores + 5-slot global pool, ContextVar
todo isolation, depth cap, retry/compaction inheritance, cancellation propagation — §10). Bugs:
cancelled subagents never mark their job rows (3.5), zero in-loop cancel checks (0.B-7), per-event
sync SQLite/file I/O per worker (3.12), one session can pin all 5 global slots 10 min (3.9).

### 0.B Verified ground truths (do not re-debate)

1. **Real loop** is `workbench.py:2395 sendWorkbenchMessageStream → :2504
   _sendWorkbenchMessageStreamImpl → :3236 while True # toolRound` (6493 lines). `kernel.py`
   WarmKernel is the code-mode sandbox, not the loop.
2. **`openaiResponses` workbench misroute CONFIRMED.** `is_openai_api_format` covers Chat+Responses
   (`providers/api_format.py:76`); the workbench branches only `isAnthropic/isOpenai`
   (`workbench.py:2821,3411`); the only streaming OpenAI client method is `chat_completions_stream`
   (`providers/clients/openai.py:54` — `responses()` at `:69` is non-streaming). A model set to
   `openaiResponses` gets a chat-completions call against a Responses endpoint: same model works
   via the `/v1` proxy (which has the translator, `adapters/openai.py:528-614`), fails via the
   workbench. `effort.py:223` raw `== 'openaiResponses'` misses aliases.
3. **Proxy stream-usage regex BROKEN.** `routers/proxy.py:329-330` raw-string `[:\\s]` is
   `{':','\\','s'}`, `(\\d+)` matches literal `\ddd` — streamed turns always report 0 tok;
   non-stream path (`:268-270`) unaffected.
4. **Barrier-1 failure leaves a phantom empty assistant message CONFIRMED in shape.** On
   `_flushSessionBarrier` failure (`workbench.py:3360-3373`) the `break` exits only the chain
   loop; the chain-exhausted guard (`:3560`) misses; `response` is still `{}` so
   `response.get('error')` skips error handling (`:3567`); the empty-assistant build
   (`:3648-3662`) runs anyway, the message appends (`:3743`), persists, and `done` is emitted
   after `error` (`:4980-4990`).
5. **Live turn bypass CONFIRMED.** `routers/live.py` has zero refs to `_activeStreams`/cancel/
   queue/lock (grep-verified); direct `session.messages.append` ×2 (`:174-175`) races workbench
   turn writes; invisible to `/chat/active`, Stop, and the prune probe.
6. **Subagent cancel-blindness CONFIRMED.** Zero `_isCancelled`/`_cancel_event` checks in the
   worker loop (`workbench/subagent.py`, grep-verified); only external
   `cancel_subagent_tasks_for_session`. Plus `except Exception` at `:1168` misses
   `CancelledError`, so job rows stay `running` forever (3.5).
7. **`session._state_lock` lazy-init race CONFIRMED** (`workbench.py:6454-6455` check-then-act,
   loop-bound lock; transcript writes bypass it entirely). †
8. **Prompt cache is still dead weight.** `workbench/prompt_cache.py` still exists (v1's Phase 6.4
   deletion never landed); `get/set/stats` have zero production callers — only `.clear()`
   (`workbench.py:821`, `skill_service.py:524`).
9. **`MessageBubble` is NOT memoized** (verified: `ChatThreadMessagePane.tsx:12,195` render, no
   `memo(` in `MessageBubble.tsx`) — v1 Phase 5.5's frontend perf items never landed (the Phase 5
   commit was backend-only). They are re-listed in 7.7.
10. **autoRoute: frontend opt-in ghost, backend loop dead.** `useChatSend.ts:213,610` reads
    `august_auto_route==='1'` but nothing ever writes `'1'` (only `'0'`, `:647`); backend
    `autoRoute*` keys accepted/stored, no turn-loop reader (only `harness_self_improve.py:148`
    introspection of `autoRouteMinSamples`). Tombstone `sessions.py:108-110`. The suggestions
    consumers read `.model` while the backend sends `modelId` (7.2).
11. **No verifier gate** (zero `verifierEnforced` hits) — no action.
12. **stopChat double-terminal CONFIRMED**: `routers/workbench.py:115-116` (and `:532-533`) append
    `aborted` **then** `done`.

---

## Phase 1 — Model wire path: kill the 500-class

### 1.1 Retry-without-tools fallback (headline) — P1
Trigger in the turn retry loop (`workbench.py:3459-3531`): retryable error or any
`errorStatus >= 500`, tools non-empty, nothing emitted yet, not quota/deterministic-400 → retry
**once** with tools stripped before the last identical-body retry; also on the empty-response
error (`providers.py:867-875`).
- Strip tools AND tool history, both formats: OpenAI — drop `body['tools']`, rewrite `role:'tool'`
  messages into user-role text lines (strict gateways 400 on tool-role with no tools declared);
  Anthropic — drop `tools`, remove `tool_use`/`tool_result`/unsigned `thinking` blocks.
- Prepend: `[Proxy Self-Heal] The tool transport failed upstream for this model, so tools are
  unavailable for this reply. Answer in plain text; if action is needed, describe the exact
  commands/edits for the user.` (miner already whitelists the prefix, `episode_miner.py:130`).
- Knob: `workbench.retry.toolsFallback: true` in `_modelRetryPolicy` (`workbench.py:471-492`);
  per-model override next to `toolSurface` (`routers/models.py:197-213`).
- UX: emit a `warning` event; after a confirmed tools-500 + successful fallback, emit
  `modelProfileSuggestion` so the user can apply `toolSurface=reduced/text` one-click.
- Guards: never after partial emission (`_retryBlockedByPartialEmission`, `workbench.py:277-283`);
  once per turn per chain model; skip when tools already empty.
- Tests: stub client 500s tools body then streams success tool-less (assert no `tools` key +
  flattened history); knob-off → old behavior; partial-emission → no fallback; Anthropic
  block-stripping; tool-less answer accepted as turn result.

### 1.2 Progressive disclosure + one tool list per turn on the OpenAI path — P1
`openaiToolDefinitions` (`workbench.py:1810-1886`) sends the registry verbatim; only the Anthropic
builder runs `assembleToolDefs` and stores `session._tool_assembly` (`:1677-1681`). Run the same
BM25-budgeted assembly on the OpenAI path (shared core set; bare-first ordering already exists on
both, `:1656-1658`/`:1841-1843`). Also build only the list the resolved format needs per turn —
today both are built unconditionally (`:2818-2819`) † — and apply the capability profile
**before** BM25 (today `tools[:maxTools]` slices after ranking, discarding relevance †). Shrinks
unknown-model requests ~4× (cost + 500-rate); 1.1 is the safety net.

### 1.3 `openaiResponses` workbench support (ground truth 0.B-2) — P1
Add `responses_stream` to `OpenAIClient` (`providers/clients/openai.py:54-75`), branch
`call_openai_workbench` on **normalized** format, port the proxy's body translator
(`adapters/openai.py:536-594`; messages→input/instructions, function_call history rewrite). URL via
`provider_endpoint_url(base, fmt, kind='responses')`, never string-replace (`adapters/openai.py:595`
fragile) †. Normalize all format comparisons (`adapters/openai.py:499`, `adapters/anthropic.py:719`,
`effort.py:223` → `normalize_api_format`/`is_*_api_format`) and add a case-insensitive
`find_model_entry()` helper (today `providers.py:659` misses `GPT-5` vs `gpt-5` caps) †.

### 1.4 Chat/code mode still ships the full tool array upstream — P2
`workbench.py:3412-3432` passes `tools`/`openaiTools` unconditionally; `chat` mode only blocks
*execution* (`:3862-3878`) while the prompt says "Tool calls are blocked". Pass `[]` for `chat`
(and arguably `code`, whose prompt says "Do NOT call tools") — the ~20k-token array rides upstream
for zero benefit.

### 1.5 Upstream body hardening — P2
- Unify deep `strip_none_deep` at the adapter boundary; add `_endpoint` to August-only keys
  (today stripped only at `adapters/openai.py:534`) — the 0.12.21 null-reject class, one layer
  earlier †.
- `reasoning` keys always attached to round-2 assistant history (`attach_openai_reasoning`,
  `adapters/reasoning_policy.py:8-19`; same keys from `adapters/anthropic.py:261-263`) — strict
  gateways 400 on unknown fields for models that never streamed reasoning-into-history. Add a
  per-model `preserveReasoning` flag (default true) or strip on the tools-fallback retry.
- `max_tokens` has no `max_completion_tokens` path (`providers.py:650`): OpenAI reasoners reject
  it, and the error text routes into `_CONTEXT_OVERFLOW_MARKERS` handling (`workbench.py:503`) →
  pointless context reduction. Mirror the `reasoning_effort` self-heal (`providers.py:717-732`):
  on a `max_completion_tokens` error, resend once renamed.

### 1.6 Error fidelity & accounting — P2
- **Proxy usage regex** (ground truth 0.B-3): fix to
  `r'"(?:input_tokens|prompt_tokens)"\s*:\s*(\d+)'` (same for output).
- **Usage semantics**: `totalInputTokens += input_tokens` per round (`workbench.py:3604`) sums the
  full prompt every round (cache-aware fields are tracked at `:3608-3619` but the headline totals
  inflate ~N× on tool-heavy turns) → decide max-vs-sum per surface (context display = last/max;
  billing = true per-request sum incl. cached) and make cost-ceiling (`:3174`), lifetime totals
  (`:4967`) and the context chip consistent †.
- **Status preservation**: early-error returns lack `{type,status}` (`adapters/openai.py:484,491,501`,
  `adapters/anthropic.py:678`) so `_endNonStream` defaults to 502 (`proxy.py:246` does read
  `result['status']` — the gap is upstream); fix empty-hint to forward `error_status`
  (`stream_translate.py:172`, `providers.py:867`) †.
- **`upstreamRetry` leaks** on two /v1 pass-throughs Part 25 missed: `streamOpenaiSseToClient`
  (`adapters/openai.py:312-339`) and `_streamResponsesPassThrough` (`:354-378`) — add the same
  `continue` filter strict SDK clients need.

### 1.7 Wire-path P3 batch
- Untruncated upstream error body in the OpenAI workbench path (`providers.py:158-177`, unbounded
  read `base.py:582-586`) — truncate ~500-800 chars (Anthropic aggregator does:
  `stream_translate.py:75-77`).
- In-band Anthropic error events lose status (`stream_translate.py:169-170`; top branch `:66-78`
  extracts it).
- Never sends `stream_options: {'include_usage': true}` (`providers.py:642-670`) → 0-token turns
  on OpenAI-proper streams; add defensively with a drop-and-retry.
- Dead fleet key `chat_smol`: `subagent.py:445` asks `getModelForRole('chat_smol')`; roles
  (`model_fleet_service.py:13-23`) have no such entry → silently falls back to `cortex`.
- Unresolvable model → confusing transport error: `providers/resolver.py:180-201` returns a
  synthetic provider with `baseUrl: ''` → relative URL → "connection error". Raise typed error.
- GC-closed upstream generators: breaking out of `messages_stream` (`providers.py:486-519`) relies
  on GC; proxy wrapper `aclose()`s explicitly (`proxy.py:397-406`), workbench doesn't.
- TTFB bound missing on non-streaming calls (`requestJson`, `base.py:472`; watchdog exists only in
  `streamSse`, `:619-630`) — background review calls are non-stream (`providers.py:92`).

---

## Phase 2 — Turn-loop durability & accounting

### 2.1 Barrier-1 phantom message (ground truth 0.B-4) — P0
Guard after the chain loop (~`:3560`): if `turnError and not response` break the outer loop before
usage/assistantMsg; skip append/persist; suppress `done` after a barrier error (emit error only).
Test: barrier fail leaves no phantom message.

### 2.2 Stopped sessions get a phantom "[interrupted]" user bubble after restart — P0
`durability.py:49` persists `session.turnOpen = True` on every barrier flush; reset only at normal
turn end (`workbench.py:4882`) and in the recovery path itself (`sessions.py:221`). Stop/cancel/
delete paths (`routers/workbench.py:104-118`, `stopChat` `:521-527`) reset `status` but never
`turnOpen` before `saveSessions()` → `fromDict` (`sessions.py:204-222`) fabricates a synthetic
interrupted **user** message on every cleanly-stopped session. Second half: the reload/recovery
path can run while the turn is still live under window pressure (two objects for one id).
Fix: set `turnOpen = False` in the abort handlers before `saveSessions()`; treat `turnOpen` as
orphaned only when `updatedAt` is older than a few minutes; register the router probe before any
reload.

### 2.3 Stall & loop-budget accounting — P1 †
- Stall exception path defaults to `('',0)` instead of skipping (`:3256`); stall check should fire
  from round ~8-10, not 22 (today 12+8 vs cap 25).
- Narration/refusal/queue `continue`s (`:3601,3785,3800,3714`) must not consume `toolRound` budget.
- Promotion flag inside resolve-success (`:3539-3541`); separate `promotionUsedAt` from
  `chainUsedAt`; partial-emission check before overflow retry (`:3462` vs `:3502`).

### 2.4 Cancel-strip & teardown hygiene — P2 †
Skip appending the stripped-empty assistantMsg (`:4706-4725` → `:4718` guard); hoist ~15
per-round/per-tool imports to module top (`:3397,3665,4137,4249,4747,4761,4775`); cost-ceiling
early return must reset `current_subprocess_cancel` (`:3197` leaks the token; `STOP` hook needs
`except BaseException`).

### 2.5 Retry-classification gaps — P2 †
- Widen the 400-marker list with `budget_tokens/thinking/schema/model not found`
  (`workbench.py:239-249` too narrow → useless retries).
- Rebuild `systemText` on text-protocol downgrade (`:3759` sets the flag, never rebuilds — the
  prompt is dead the turn it matters).
- Trim the tail-patched `<memory>`/`<session_state>` blocks at persist (`:2973` — the admitted
  TODO; also fixes mining poison, 6.3).

---

## Phase 3 — Sessions, cancel & subagents

### 3.1 Service-layer per-session turn guard — P0
The only one-turn-per-session gate is `routers/workbench.py:27` `_activeStreams` + queue logic
(`:404-422`), which also has a queue-gate race `:407-424` †. Unattended callers bypass it:
`bot_mode/dm.py:358,371` (DM + sender wake), `bot_mode/rooms.py:301` (member turns),
`automation_memory.py:470,483` (routine respond-turn, fire-and-forget). Two overlapping turns on
one session = interleaved `session.messages.append` (`workbench.py:2577`), racing barrier flushes,
duplicated SSE `started`/`done`. Fix: module-level `dict[str, asyncio.Lock]` acquired at the top of
`sendWorkbenchMessageStream`; unattended callers pass `wait=False` → structured "busy" →
re-enqueue via `enqueueUserMessage`; the router keeps queue semantics on top and gets a per-session
turn lock in `POST /chat` †. The registry doubles as the active-turn probe (fixes 3.9/3.10).

### 3.2 Live turn bypass (ground truth 0.B-5) — P0 †
`routers/live.py:87-188` runs its own duplicate loop with zero gate refs and direct
`session.messages.append` (`:174-175`). Route Live through the workbench stream with `tools=[]`
(delete `live.py:107-181`); interim: gate + lock Live on the same registry as 3.1.

### 3.3 Session-mutating routes race live turns — P0
`undoLastTurn`/`truncateSession` (`routers/workbench.py:1819-1855`) and `restoreCheckpointRoute`
(`:1207-1219`, deletes workspace files, `checkpoint_service.py:243-273`) have no in-flight-turn
check while the turn loop holds `currentMessages = list(session.messages)`
(`workbench.py:2883,2966`) — a concurrent truncate is silently resurrected by the next barrier
flush; restore can delete files a running edit-turn is about to write. Fix: reuse the
`_session_turn_in_flight` probe → 409 "stop the session first".

### 3.4 Session persistence: full DELETE+re-INSERT per barrier on the loop — P0
`memory_store/sessions.py:130-148` deletes and re-INSERTs the whole transcript per
`flush_session_barrier` (`durability.py:50-54`; fired per model dispatch, per top-level tool, per
step boundary — `workbench.py:3362,4176,4731`), synchronously on the event loop; `synchronous=FULL`
(`memory_conn.py:43-44`) fsyncs each commit. Fix: move the barrier body to `asyncio.to_thread`
(worker threads commit immediately per `deferred_writes.py:99-101` — strictly more durable);
coalesce to per-round, not per-tool (`:4175`) †; longer term delta UPSERT keyed `(session_id, seq)`.

### 3.5 Cancelled subagents leave jobs stuck at `running` forever — P0
`workbench/subagent.py:1168` `except Exception` misses `CancelledError` → `updateJob(failed)`
never runs; `subagent_orchestrator.py:805-809` marks the handle but never the `job_xxx` row;
`workbench.py:2657` recurring wrapper same. Fix: `except asyncio.CancelledError` in
`executeSubAgent` → `updateJob({'status':'failed','error':'cancelled'})` + `subagentDone
status='cancelled'` → re-`raise`; thread `jobId` onto `SubagentHandle`; thread the parent cancel
signal into `SubagentSpawnRequest/_runWithSlot/executeSubAgent` with per-round checks + graceful
transcript strip mirroring `:4706` (zero in-loop cancel checks today, ground truth 0.B-6) †.

### 3.6 Session lifecycle races — P1 †
- Eager `_state_lock` in `__post_init__` (ground truth 0.B-7) + key on `(id(loop), sid)` — today
  `updateSessionState` catches `RuntimeError` → silent dropped write (`workbench.py:6454-6455`);
  lock all `_sessions` inserts/deletes; `toDict` copies lists.
- Stop-handler single-terminal (ground truth 0.B-12): today double `aborted,done`.
- Unify delete paths (`routers/sessions.py:134` → `delete_workbench_session`); bind gateway
  `_cancels` + recurring tasks to the workbench sessionId; cap `queuedUserMessages` at 20 with
  drop-oldest (`workbench.py:2015-2031` unbounded, verified).
- Snapshot prune can evict a live Bot/automation session: `sessions.py:559-566` consults only the
  router's `_activeStreams`, so unattended turns are invisible → a Bot canonical chat can fall out
  of the 60-slot window mid-turn and its DM/room replies vanish on stale-copy save.

### 3.7 Per-worker isolation & tallies — P2 †
Per-worker session snapshot (model/provider/workspace/guard + shallow metadata) + depth via
ContextVar instead of shared `session.subagent_depth` (`subagent.py:245`); receipts to the
workstream store, not `session.metadata` (`:335`). Tally batch: `partial` passthrough
(`worker:144`), `stopped` arm (`orchestrator:828` + tally `:719`), no clamp-regeneration (`:419`
reject at cap), default-deny unknown agents, wrap-once emit (waves ≥2 double-touch), taskIds in
background returns, effort-aware 240s timeout, `isStalling` ≥ attempt-start touch, evict
semaphores/tasks/proposals on timer, session-bind steer/terminate.

### 3.8 Rooms have no per-room send guard — P2
`routers/agents.py:280-293` awaits `rooms.run_room` unchecked; two concurrent sends double-deliver
(per-driver `last_seen = {m: 0}`, `rooms.py:321-433`). Fix: per-room `asyncio.Lock`; `{'status':
'busy'}` on contention.

### 3.9 One session can pin all 5 global subagent slots — P2
`subagent_orchestrator.py`: pool fixed at 5 (`:48`), per-session `maxConcurrent` up to 30 pins
slots with a 600 s wait timeout (`:53`) — one orchestrator starves every other session;
`_sessionSemaphores` (`:332`) never evicted on terminate/close. Fix: drop entries on
`terminateForSession`/`close`; fair-share the global gate; document the policy.

### 3.10 Smaller concurrency fixes — P2/P3
- `enqueueUserMessage` uses `_sessions.get` (`workbench.py:2014`) → a pruned session silently
  drops the subagent completion notice; use `get_workbench_session`.
- Snapshot writer serializes all kept sessions per pass (`sessions.py:569-631`); track
  `_dirty_sids` and write only changed sessions.
- Per-event sync I/O per subagent: `_record_run` (SQLite commit) + `_append_transcript` (file
  rewrite >200 KB) on every worker emit (`subagent_orchestrator.py:386-406,207,77-80`) —
  write-behind + writer thread (the `event_log.py` pattern), cap touch-updates to status changes.
- `_doSpawn` cancel path leaves workstream lanes `running` forever
  (`spawn_subagents_tool.py:685-690` vs lanes written `:629`) — mark running lanes cancelled.
- Unattended-turn burst: `tick_automations` (`automations_store.py:966-977`) starts every due job
  immediately — wake-from-sleep with 50 due jobs = 50 simultaneous turns; global unattended
  semaphore around `_run_workbench_stream` (mirror `_recurringSubagentSlots`, `workbench.py:78`);
  run `boot_automations` recovery at scheduler start.
- P3: `memory_store.init()` schema walk per barrier (`durability.py:53`) → module flag;
  `agent_registry` job KV one unbounded read-modify-write blob with last-writer-wins races
  (`agent_registry.py:204-234`) → small lock + prune terminal jobs; `subagent_runs` retention
  sweep (20 KB `result_full`, never deleted); `event_log._sessions` never evicts;
  `deferred_writes._timers` stale-handle pop.

---

## Phase 4 — Tools / sandbox / MCP / PTY †

### 4.1 Tool-call bridge approval — P1
`tool_bridges.py:132`: add `_resolveCommandApproval` + read-before-edit to the `tool_call` bridge,
or route it through `_executeTool`. Code-mode FS writes: enforce ask/edit grants inside the
preamble bridge (`code_runner.py:81`). Unify read-before-edit vs verify tool sets.

### 4.2 One mutating-tool authority — P1
Three same-purpose authorities disagree (verified): `harness_mode.py:84 is_mutating_tool(name)`,
`tool_policy.py:243 is_mutating(name, args)`, plus the parallel-read allowlist
(`workbench/parallel_tools.py` + `workbench/managed_tool_policy.py`). Same-name/different-rules;
`search_and_replace` is treated as safe on at least one authority → parallel-writer race. Fix:
one `is_mutating(tool, args)` authority; add `bulk/write_files/apply_patch` to the hash regex's
`\b` coverage; serial-classify `search_and_replace`.

### 4.3 Sandbox & process hygiene — P2
Warm-kernel: periodic `reap_idle_warm_kernels` + `await proc.wait()` + pipe close (`kill` leaks)
†; guard boot with the session lock; `shutdown_all` waits. PTY: `close(from_reader)` self-join
RuntimeError (`pty_io.py:257`); `waitpid(WNOHANG)`/executor (blocks loop, `:152`); deque buffer
(O(n²) concat, `:429`); TTL `_pendingApprovals`. Code-runner: reap `code_runs/`, cap `rglob`,
cap `repr`, cap pickle-read, reuse `kernel_dir`; `verify_after_edit` net flag per tool;
`worktree_hash` skip when lint-only.

### 4.4 MCP client races — P2 †
Per-proc lock for the `tools/list msg_id=1` race (`:974`); `create_task`-from-sync guards
(`:160,192`); evict `_session_locks/_remote_sessions/_stderr_tasks/_mcpCleanupTasks`; catch
`OSError` at spawn (`:413`); bump/overrun-guard stdio reads; a NDJSON non-JSON line shouldn't reap
a healthy server.

### 4.5 Policy regex audit — P3 †
`format` substring, `rm ` spacing, `$()` split, `>.env` tokenize — audit + parity tests (the
parity-oracle rule: update policy and oracle together).

---

## Phase 5 — Trust boundary & privacy

### 5.1 Privacy purge does not erase the learning corpus — P0
`routers/privacy.py:50-55` `_MEMORY_TABLES` omits `episodes` (raw user-message excerpts,
`episode_miner.py:166-171`), `failure_fingerprints`, `turn_outcomes`. `messages` is intentionally
kept, so the next 24 h pass re-mines everything (`episode_miner.py:648-671`) and a tier-2
`memory` verdict re-writes **new facts** about the user (`skill_distiller.py:334-342`); the
Curator UI still shows raw excerpts. Fix: add the three tables (keep the
`invalidate_fact_index()` call); optionally gate distiller `memory` verdicts for N days post-purge.

### 5.2 Security batch — P1/P2 †
`security.py:172` enforce allowedRoots; sanitize `obs_id` (`:110`); `/safe` returns the full
config dict incl. credentials (verified: `routers/config.py:142` docstring) → redact keys;
webhook header-only token (`automations.py:259`); privacy export paginate + `truncated:true`;
usage heatmap honor `range` + UTC streaks; exam path basename normalize; Live create rate-limit;
`live_speech.py:61` reuse pasted-base+leaf (never invent `/v1` — the AGENTS.md baseUrl rule);
`deferred_writes` weakref key; event-log tail-rehydrate cap.

---

## Phase 6 — Memory / skills / learning

### 6.1 `brain_query` returns superseded/expired facts (reproduced live) — P1
Part 25's `_visibility_where` (`rest.py:141-160`) applies to `list_facts`/`search_facts` only;
`brain_query('facts')` has the scope union but no status/expiry clause, and the exact-key fast
path is `SELECT * FROM facts WHERE fact_key = ?` (`brain.py:264-269,360-367`). Verified: a
`superseded` fact and a past-`expires_at` fact both come back verbatim through the model's
memory-search tool. Fix: reuse `_visibility_where(scope)` in both paths.

### 6.2 `remember` refuses global-key updates from bot chats while `forget` can delete them — P1
`session_tools.py:339-351` refuses any cross-scope key; `:499-509` lets `forget` hard-delete a
global row. The per-turn `<memory>` block instructs "update one by passing its key to remember"
(`fact_retrieval.py:368-371`) — every global fact's update is refused while the delete path can
destroy shared memory. Fix: one rule for both doors — visible-union rows are updatable; only rows
outside are refused. Update the stale docstring (`rest.py:49-53`).

### 6.3 Persisted tail blocks poison episode mining into phantom corrections — P1
The tail-patched last-user message **is** persisted (`workbench.py:2966-2971,3107-3115`) and the
miner's injection filter is prefix-only (`episode_miner.py:126-140`) — `<memory_nudge>` contains
"correction" (`prompt_segments_cache.py:81-86`) and matches `_CORRECTION_RE` → every nudge turn
mines a phantom `user_correction` episode → fake fingerprints, inflated recurrence, wasted tier-2
judge calls. Fix: 2.5's persist-trim (preferred), or strip from the first
`<memory>`/`<session_state>`/`<memory_nudge>`/`<relevant_skills>` occurrence in `_extractEvents`.

### 6.4 Learning pipeline ignores the scope axis — P1
`mine_sessions` selects all sessions (`episode_miner.py:654-661`); `skill_distiller.py:333-342`
writes judge `memory` verdicts with **no** scope → global. A Bot's private failures resurface as
globally injected lessons in every session. Fix: stamp episodes with the source session's resolved
scope; thread scope into `apply_verdict`'s `save_fact` (bot-scoped → `bot:<id>` rows or
extract-only).

### 6.5 Cross-scope `save_fact` overwrites another scope's private value (reproduced live) — P1
`rest.py:64-90` `ON CONFLICT(fact_key) DO UPDATE` never touches `scope`; only
`session_tools._remember` guards. Verified: `save_fact(key, scope='bot:alpha')` then
`save_fact(key, scope='global')` succeeds — row keeps `bot:alpha`, carries the other writer's
content. Reachable from the Settings-UI manage endpoint (`routers/august.py:497-501`), bulk import
(`:664-669`), and rollback restore (`rollback_store.py:230-247` also resurrects a deleted bot
fact as a *global* row). Fix: refuse/log on non-global scope mismatch (explicit consolidation
override excepted); pass original `scope` through rollback.

### 6.6 Hot-path waste — P2 †
Catalogue memo single-slot thrashes across scopes (`skill_service.py:88-89` — a bot chat + a
workspace chat alternate the key → full ~84-file rebuild per turn) → keyed dict. Fuse the double
`search_entries` per turn (`fact_retrieval.py:326+:328` — re-confirmed live in Scan B, ground
truth 0.B-9's source) + mtime-TTL `read_entries`; cache skills-BM25 on the catalogue key;
`getRuntimeConfig()` 1×/turn (today 3-4); recall metrics into `turn_outcomes` (kill the
read-modify-write race, `workbench.py:3049`); overflow record off the prompt path
(`capabilities_prompt.py:297`); gate `build_memory_block` on query length + empty-workspace skip;
consolidation `new_event_loop` → shared executor.

### 6.7 Scope & correctness batch — P2/P3
- Scope-partition the timeline section of `brain_index_snippet` (`brain.py:624-634` — every
  session's summaries land in every boot index; needs a scope column or a documented
  shared-timeline decision); add the scope filter to `brain_browse` (list/search have it) †.
- Tier-1 catalogue + intake line miss the bot root (`workbench.py:1014,1223` call `catalogue()`
  without `agent_id`; the per-turn block threads it — half-wired).
- TTL facts keep injecting past expiry until the next invalidation (`fact_retrieval.py:107-113`
  filters only at cache-build; up to 24 h window) — per-candidate re-check.
- `mine_sessions` has no per-session cursor (full 30-day re-parse every pass) — persist
  last-mined message id in `internal_state`.
- Session cascade misses learning tables (`memory_store/sessions.py:240-251`) → add
  `episodes`/`turn_outcomes` (deleting a session orphans raw excerpts, still queryable in
  Curator).
- `recalled-memories` rows hardcode `scope: 'global'` (`fact_retrieval.py:379-385`) — carry true
  scope.
- `touch_usage` `len≥8` guard for keys too (titles only today) †; consolidation write passes leave
  an open transaction on mid-loop failure (`consolidation.py:376-386,412-421`) →
  `try/finally: rollback()`; bust-or-document frozen-index staleness †.

### 6.8 Self-heal & JSON-salvage tuning — P3 †
Self-heal: precompile regexes, `^Error:` gate (today `error:` substring false-positives), inspect
`toolInput.command` not output, hint dedup, Anthropic-shape support (today `role:tool` check
misses `tool_result` blocks). JSON salvage: prefer `json` fence, global `,}` fix, quote/comment
tolerance, 64 KB candidate cap, drop-or-support the array branch.

### 6.9 Memory-import track (the asked-for feature gap) — P2 †
- **Project bulk import in UI**: dialog sends no `scope/workspace` (`ImportMemoryDialog.tsx:372`;
  `MemorySection.tsx:1146` passes no workspace) → add scope toggle + workspace select;
  backend hardcodes `memory.md` (`routers/august.py:440,571-612`) — respect per-item `file`.
- **Chat-log importer (new)**: none exists (verified); accept MD/JSONL transcripts → parse speaker
  turns → import as session transcript or distill to facts via `save_fact`. Closes the
  export→import loop (export emits md, `MemorySection.tsx:631`, un-reimportable).
- **Skills bulk importer (new)**: no `/api/skills/import` (verified) — accept directory/ZIP of
  `SKILL.md` → validate via `skill_service` rules → write to chosen root → per-file report.
- **SQLite-file importer (new)**: `memory_conn.py:95-103` tells users to import via Settings →
  Memory but no DB-file endpoint exists (verified) — accept `august_brain.sqlite` upload → merge
  facts upsert by `fact_key`, scope-preserving.
- **Import robustness**: key-collision warning (today later-wins silent, `:162`); preserve
  `confidence`; 6-word-slug collision guard; project `file` per-item.

---

## Phase 7 — Frontend

### 7.1 Debate auto-run triple bug — P0
`DebateView.tsx:59-64`: `round` increments **after** `await startChatStream` resolves but the
`done` handler (`debate-store.ts:79-84`) fires during the stream → identical opening prompt
re-sent to the same model; judge summary dispatches twice (`judgeSent` post-await). `:37`: the
judge branch picks the lane via `nextDebater(run)` = `models[maxRounds % 2]` — the judge model is
never used. `:119-125`: closing mid-judge → `{...null}` truthy run → `run.models.map` throws,
no error boundary → chat crash. Fix: increment/flip state synchronously at dispatch; explicit
`lane` parameter; re-read run and bail if null.

### 7.2 Suggestions shape + autoRoute purge — P1
Backend `routers/brain_config.py:404` sends `modelId`; frontend reads `.model`
(`ArenaLaunchModal.tsx:54-56,233-241` → blank chips + duplicate-key warnings;
`useChatSend.ts:624-641` → toast "Auto-routed to undefined"). Fix: read `modelId`; delete the
dormant `august_auto_route` block (`useChatSend.ts:211-224,607-665`) and the three inert
`autoRoute`/`autoRouteMinWinRate`/`autoRouteWinGap` keys (`brain_config_service.py:100-103`;
keep `autoRouteMinSamples` — read by `harness_self_improve.py:148`); update
`test_brain_config.py:36-39` †; add a suggestions contract test.

### 7.3 Dead/poisoned UI surfaces — P2
- Right-drawer "Trajectory" polls deleted `GET /api/harness/traces`
  (`api/harness.ts:39-47`; route removed in `4f1bfdb1`) every 8 s from a user-openable tab —
  delete section + api file or re-home on turn-outcomes.
- Memory "Add a memory" on the Memories tab posts `action:'set'` → backend writes the **facts**
  table (`routers/august.py:484-503` → `rest.py:77-99`) while the tab lists only the KV store
  (`MemorySection.tsx:97-108,652-674`) — "saved" entries never appear. Route by active store.
- Arena lane "Re-ask" truncates from the **first** user index (`ArenaView.tsx:257-269`) — lanes
  are seeded with the source prefix (`launchArenaRun.ts:45-64`), so restart deletes prior context
  server-side while the UI keeps showing it. Use `lastIndexOf('user')` (as the model-switch
  auto-continue does, `ChatThread.tsx:1016`) and replace the local list.
- RoutinesPane "hourly" builds `` `0 ${minute} * * *` `` → hour 30/45 invalid (creation 400) or
  daily-at-midnight (`RoutinesPane.tsx:41`) → emit `${minute} * * * *`.

### 7.4 Frontend perf batch — P2 (v1 Phase 5.5 leftovers, never landed + Scan B additions †)
- `memo(MessageBubble)` (verified still unmemoized, `ChatThreadMessagePane.tsx:195`); O(1)
  assistant-index patch (today O(n) map per 32 ms flush); virtualize-always.
- Hoist `useLiveBackendAction` to singleton (today ×N tools SSE+poll); single `useNow` shared at
  1 s (ReasoningBlock 100 ms, ToolCallItem 500 ms today); consolidate the 2 s/15 s/5 s poller
  fan-out (`ChatLayout:261,273`, `chat-active-streams`, `useSessionStream` status) into one 12 s
  poller + SSE invalidate; equality-check `chat-active-streams:74`.
- Empty-patch bail + stable ids (`Date.now+random` breaks memo) + `Record` stores + per-session
  selectors; context-ring/transcriptChars to idle/`onDone`; preview cap + 100 ms `tool_progress`;
  CSS shimmer instead of per-char spans; dedupe `ensureWorkbenchSession` (promise cache);
  memoized id-map; preserve `planSubmittedLive` in `bind-turn-handlers`; forward `done.context`;
  real `isTurnVisible`; `turnTelemetry` dispatch or schema-claim removal; background compaction
  card; Tauri probe `proxyPort()` first.

### 7.5 Frontend smaller fixes — P3
- Dead client helpers incl. one aimed at a nonexistent route: `api/subagents.ts:319-349`
  (`saveSkillFromEpisode` → `/api/subagents/workstreams/{name}/save-skill` doesn't exist;
  `listJobs`/`cancelWave`/`searchHarness`/`markWorkstreamRead` zero callers);
  `api/workbench.ts:260-275` `resetWorkbenchSession` uncalled + builds a `//` URL on empty id.
- `AuditTimeline.tsx:17` filter options are values nothing emits → every pick renders an
  always-empty timeline; populate from real categories.
- Queued message plays the "response complete" chime + OS notification
  (`start-stop-stream.ts:119-137`); double failure notification (`stream.ts:60-66` onError+throw,
  caught and onError again `:179`).
- `ArenaView` mounts unconditionally with always-on hooks (`ChatThread.tsx:1401`): subscribe-all
  streams + 30 s poll even when never opened — gate on `run || archiveOpen`.
- Vite `manualChunks`: `id.includes('react')` matches `lucide-react`/`@tanstack/react-*` before
  their buckets (`vite.config.ts:26-29`) — reorder specific-first.
- Vestigial `pendingConfirmations` map + legacy diff-gate (`makeStreamHandlers.ts:165,171-177,
  418-426,880`); `truncate_session` docstring says inclusive, code is exclusive
  (`sessions.py:1173`); brain-config knobs with no settings surface (`maxWorkbenchToolLoops`,
  `projectMemory`/`projectSkills`, …) — discoverability gap.

---

## Phase 8 — Per-turn backend cost — P2 † (merge-checked against landed Part 25 Phase 5)

Subagent tool assembly reuse: `executeSubAgent` re-derives `toolDefinitions` +
`openaiToolDefinitions` per launch (`subagent.py:469-470`), each a full `assembleToolDefs` walk
over the transcript — pass the parent's assembled defs (cache key
`(session_id, len(messages), guardMode)`). Frozen `tool_defs_cache` (drop `deepcopy` after
proving no in-place mutation); token-estimate memo + single heuristic; `to_thread` for
git-probe/code-map/saveSessions/spill; tokenizer singletons + `computeBudget`/turn reuse;
`invalidate_path` scoped fix (today global `clear()` on any write + dead `invalidate_path` +
paged-key mismatch); shadow baseline `Event` + marker lock + lock evict;
`ToolCallTracker._hashArgs` real hash + LRU; terminal shared preflight; warm cells send diffs;
MCP client reuse + gather-discover(3); `annotate_errors` single-read; heartbeat lazy after 8 s
(`:4359`); `BatchedEmit` 256→1024+; partition parallel batches (today all-or-nothing,
`chat_stages.py:73`) + `Semaphore(8)` + cancel-aware gather.

---

## Phase 9 — Dead code, config drift, CI & docs

### 9.1 Red CI gates — P0
`node scripts/check-naming.mjs` exits 1 (verified live): 19 unbaselined camelCase params
(`workbench.py:835` `rememberOffered`, `episode_miner.py` ×9, `skill_distiller.py`
`batchSize/dryRun`, `text_similarity.py` `textA/textB`, `consolidation.py` `decidedBy`, …);
`.github/workflows/type-check.yml:43` also gates eslint: 161 errors on `frontend/desktop` (27
auto-fixable) — a desktop release shipped from this red-gate tree. Fix: rename or re-baseline;
fix/ratchet eslint; same session, fix the 6 broken doc links `check-doc-links.mjs` reports.

### 9.2 Dead code — P2
- Dead `app/lib/` cluster (zero production importers): `retry.py`, `tracing.py`, `features.py`
  (so `AUGUST_FEATURES` is read only by a dead module), `stats.py`, `tokens.py`,
  `permissions.py`, `health.py:8 probeUrl`, `identity.py:10 identify`. Test-only duplicates:
  `workbench/selfheal.py` + `workbench/tool_executor.py` (live self-heal is inline,
  `workbench.py:880,3822`; live executor is `chat_stages.run_regular_tools_stage`) — delete +
  fix the stale `chat_stages.py:4` comment. Delete `workbench/prompt_cache.py` + clear-hooks
  (ground truth 0.B-8 — v1 ordered this, never landed).
- Junk: `evals/memory/default-cases.json` (fed removed evals), `scripts/create_mock_docx.py`,
  `scripts/mock-upstream.js` (Node-backend era), 5 orphaned `frontend/desktop/screenshots/*.png`;
  untracked-but-shipped stale tree `backend-py/build/lib/` (4 MB pre-purge copies poisoning
  greps) + `app/august_proxy.egg-info` → delete, consider a build hook.

### 9.3 Config drift — P2
- Documented-but-never-read: `AUGUST_DB_WRITER_LOW_DROP_S` (`CONFIGURATION.md:368`;
  `deferred_writes.py` hardcodes its windows). Read-but-undocumented: ~15 behavior-relevant vars
  (`AUGUST_TOOL_TIMEOUT_S`, `AUGUST_TTFB/CONNECT_TIMEOUT_S`, `AUGUST_CORS_ORIGINS`,
  `AUGUST_ENABLE_DOCS`, `AUGUST_COGNITIVE_BOOT` + layer toggles + `AUGUST_CONSOLIDATION_INTERVAL_S`,
  `AUGUST_SKILL_RELEVANCE`, `AUGUST_HEADLESS`, `AUGUST_WARM_KERNEL_OFF`, `AUGUST_SANDBOX_APPCONTAINER`,
  `AUGUST_AGENT_JOB_TIMEOUT`, `AUGUST_PRICE_*`, HDL/firmware resolvers, `AUGUST_ANTHROPIC_CACHE`);
  `.env.example` covers 3 vars.
- npm: unused `@modelcontextprotocol/sdk`, `node-pty`, `turndown` (root); `radix-ui` monolith +
  `@radix-ui/react-slot` + `@iconify/react` (frontend); Tailwind v4 `@tailwindcss/postcss`/
  `@tailwindcss/typography` declared while the build is v3 — real auto-upgrade drift risk.
- `backend.rs` legacy-Node ghosts: `AUGUST_PROXY_ROOT`/`AUGUST_PROXY_DESKTOP` env sets
  (`:1059-1061,1170-1172`) read by nothing; `resolveNodeBackend()` (`:596-610`) targets a
  directory that no longer exists. `scripts/doctor.py:26,71` tells users to set `AUGUST_PORT`,
  which nothing reads (real knob: `AUGUST_PROXY_PORT`).

### 9.4 Docs — P3
- `API_REFERENCE.md:392,397` still documents the deleted `/api/cron` router; add live
  arena/suggestions/proposals/MCP-harness, drop dead evals/trends rows †.
- Memory TROUBLESHOOTING: prompt-bloat/digest/frozen-indices/`AUGUST_SKILL_RELEVANCE=0`/1h-cache
  cross-links; "new skill/memory needs a new chat" note; curator `restore/pin` 404 rows
  kill-or-implement; `ARCHITECTURE` stale paths (`context_builder.py`, `skills/curator.py`,
  evals) †.
- Stale plan headers: `2026-09-04-harness-optimization.md` says "DRAFT — awaiting ruling" though
  Phases 0-7 landed; `2026-09-01-capability-research.md:302,599` cites deleted `automation_gate.py`.
- AGENTS.md leads with "Recent desktop fix (0.12.21)" while the app is at 0.17.0; version-sync
  count "7 sources" vs workflow comment "4 manifests + lockfile".

---

## Phase 10 — Coverage, release & ops — P2/P3 †

404 tests for removed evals/curator routes; one loop-level smoke (tool loop + stall nudge +
malformed downgrade + narration rule) replacing the removed `test_harness_evals.py`; arena
consumer contract test. Version docs 4→7 (`AGENTS.md:93`), hook stages lockfiles
(`package.json:24` leaves them unstaged), `--tauri`-less release stages-or-warns backend (a
backend-less "release" is possible), drop dead `backend/` refs, fix the release-stamp var-shadow,
resume `docs/releases/` past 0.13.0 (or mark archival), fill `.env.example`/compose, decide
`mcporter.json` + the evals fixture (wire or delete). Ops: daemon idle backoff (verify —
`BACKOFF_CAP = 300` exists at `daemon_manager.py:32`; confirm unarmed watches still burn
`POLL_INTERVAL = 30` polls, `:34`); scheduler cached `nextRunAt` (today up to ~524k steps/tick);
health `gather`; calendar mtime cache; usage single-pass SQL + index; dual keepalive + `since_id`;
recurring `UPDATE…WHERE` atomicity; exam transaction; Google-refresh lock.

---

## 11. Verified clean (what the scans checked and found correct)

- **SSE parsing** (`base.py:56-114`): multi-chunk lines, CRLF, comments, multi-line `data:`,
  `[DONE]` sentinel, trailing flush; JSON non-dict lines dropped.
- **AnthropicNativeStreamState** per-index accumulation + `_raw` on malformed JSON — Part 25 fix
  present and correct.
- **Retry discipline**: client retries only pre-first-token; timeout/protocol errors never
  replayed; partial-emission guard; quota fail-fast; deterministic-400 ordering.
- **Per-model apiFormat override honored at the `/v1` entries** (workbench resolve is the gap, 1.3);
  `/v1` error normalization (`_endNonStream` reads status, `:246`); `/v1/models` gateway auth.
- **Context guards**: pre-turn compaction 0.55, reactive prune-then-compact, overflow promotion
  once per turn, wire format re-resolved per chain model.
- **Concurrency sound**: router per-session turn gate + identity-checked pops; per-agent todo
  ContextVar isolation with reset; subagent retry/compaction inheritance + 240 s model timeout;
  nested-spawn blocked twice over; handle retention bounded (12/96); snapshot↔persist share
  `_persist_io_lock`; single SQLite writer discipline (WAL, thread-local conns, owner-thread-only
  deferred flush); cancellation propagates parent→stream→workers→daemon kills; automations
  re-entry guard + boot/stale recovery; DM ping-pong guard; room caps server-side; no
  `time.sleep`/`requests` in `backend-py/app`; event-log writer thread + bounded queues;
  shadow-git snapshot off-loop; compaction lock with TTL + orphan re-acquire.
- **Scope-isolation Part 25 fixes verified correct**: `_visibility_where` SQL right everywhere it
  exists; frozen boot index is per-session; list_facts LIMIT×scope correct; consolidation
  merge/supersede partitioned by scope; invalidation chain complete on every write door; FTS
  triggers + hygiene script correct; global-fact double-write from bot sessions impossible.
- **Distiller gates**: strict-JSON judge, unpooled client + cooldown, denylist on every draft,
  dedupe across all statuses, bundled-skill `-revised` supersession lineage.
- **FE↔BE contract**: Arena/Debate verdict POST/GET shapes match (modulo 7.2); chat lifecycle SSE
  framing; session/lifecycle hygiene (tombstones, debounced flush, abort cleanup); subagents/Bot
  Mode endpoint shapes match; settings IA invariants hold; memory read mappers camelCase +
  PATCH snake_case correct.
- **Purge verification**: deleted v1 modules/routers have zero surviving references; version sync
  passes at 0.17.0; all 38 registered routers live; every declared Python dep has an import site;
  Tauri capabilities map to registered plugins; signing key correctly gitignored.

## 12. Recommended build order (max risk-reduction per diff)

1.3-fix-regex + 1.5-strip-none (wire quick wins) → 2.1 + 1.6-usage (barrier guard, accounting) →
3.1 + 3.2 (turn guard, Live) → 3.5 + 3.6 (cancel, lifecycle) → 1.1 + 1.2 (toolsFallback,
disclosure) → 1.3 (Responses) → 4.1 + 4.2 (bridge, one authority) → 5.1 + 5.2 (privacy, trust) →
6.1–6.5 (memory correctness) → 6.9 (imports) → 7.1–7.3 (frontend correctness) → 7.4 + Phase 8
(perf) → 9.1 gates → Phases 9-10 remainder.

**Validation after every phase:** `cd backend-py && uv run ruff check . && uv run mypy app/ &&
uv run pytest -q` + `npm run test:frontend`; desktop checks via `npm run dev:desktop` / packaged
MSI·NSIS (releases must include the backend stamp).
