# Part 25 — Harness Optimization & Repo Hygiene (2026-09-04)

**Status: DRAFT — recommendations included; awaiting ruling before implementation.**

Method: four parallel deep-scan audits (backend harness loop / memory-learning-skills-bot-mode /
frontend desktop / cross-cutting routers-config-docs), executed against working tree `eb084dec`
(the Part-21/Phase-C/D batch landed mid-audit). Every P1/P2 finding below was spot-verified at
line level by a second pass; the three cross-agent contradictions found during consolidation are
resolved and marked *(resolved)*.

Severity: **P1** = ship-risk (silent breakage on live paths) · **P2** = latent bug or real waste ·
**P3** = cleanup.

---

## Phase 0 — P1 hotfixes (four one-session fixes)

### 0.1 `turnBudget` UnboundLocalError kills every headless turn — P1
- `backend-py/app/services/workbench/workbench.py:3106` assigns `turnBudget` only inside
  `if emit:` → `try:` → `if isinstance(_budget, dict):`; `:3130` then executes
  `_ = turnBudget  # mypy: keep alive` **unconditionally**.
- `sendWorkbenchMessageStream` defaults `emit=None` (`:2392`). Live headless callers pass no
  `emit`: `automation_memory.py:470` and `bot_mode/roster.py:287` — both crash before the first
  model call; their `except Exception: logger.debug(...)` swallows it and `session.status`
  stays `'streaming'` forever (the `finally` at `:4937` is unreachable). Every test passes
  `emit=`, so the suite never hits it.
- **Fix:** initialize `turnBudget: dict | None = None` before the block (or delete the no-op
  line). **Test:** call `sendWorkbenchMessageStream` with `emit=None` end-to-end against a
  scripted provider; assert no exception and terminal `done`.

### 0.2 Memory UI reads snake_case; `brain_browse` returns camelCase — P1
- `backend-py/app/services/memory_store/brain.py:575` wraps rows in `_row_as_wire` →
  snakeToCamel (characterization test asserts `r['factKey']`:
  `tests/test_memory_store_characterization.py:238`).
- `frontend/desktop/src/sections/settings/MemorySection.tsx:173-178,226,232,1667` read
  `r.fact_key`, `r.fact_value`, `r.updated_at`, `r.expires_at`, `r.event_summary` → all
  `undefined` against the real API: blank titles/summaries, no timestamps, expiry badges never
  fire. The unit test passes only because its fixtures (`MemorySection.test.tsx:22-40`) are
  snake_case — the test encodes the wrong shape. (PATCH `editable` keys are correctly snake;
  only the read path disagrees.)
- **Fix:** read camelCase in the UI row-mappers; rewrite the test fixtures to the wire shape.

### 0.3 `projectMemory`/`projectSkills` knobs cannot be set — P1
- In `fieldTable` (`brain_config_service.py:149,152`), served by GET, read at runtime
  (`session_tools.py:268`, `skill_service.py:74`, `workbench.py:1099`) — but missing from
  `boolKeys` (`:40-58`), so `validatePatch` (`:238`) rejects `PUT /api/brain/config` with
  "unknown field". Commit `cb626b40` claims these knobs landed; the validation tuple was not
  updated.
- **Fix:** add both to `boolKeys`. **Test:** PUT round-trip asserting persistence.

### 0.4 Stop mid-round persists dangling `tool_result`s → next turn is a non-retryable 400 — P1
- `workbench.py:4672-4685`: on `cancelledMidRound` the assistant message's `tool_use` blocks are
  stripped ("the next turn would replay dangling calls") but the round's already-produced
  `toolResults` are still appended (`:4685`), flushed (`:4690`) and persisted (`:4839`).
  Anthropic rejects a `tool_result` with no matching `tool_use`; `_DETERMINISTIC_400_MARKERS`
  (`:230-240`) makes that error non-retryable → the session is bricked. Reachable whenever a
  special tool (todos/plan/guard-block) produced a result before the cancel check at `:3825`.
  No repair exists on load (`sessions.py:200-221` only appends an `[interrupted]` marker).
- **Fix:** drop (or synthesize-cancelled) results whose ids were stripped; optionally add a
  load-time repair for already-bricked sessions. **Test:** cancel with pending toolResults,
  reload, assert history alternation valid.

---

## Phase 1 — Agent-loop correctness (P2)

| ID | File:line | Finding | Fix |
|----|-----------|---------|-----|
| 1.1 | `workbench.py:1781,3729` | `_text_tool_protocol` is set-true-only — no `False` assignment repo-wide. After one text-surface turn or 2 refusals, later turns keep the `<tool_protocol>` block (`:2753`, busts the byte-stable system prompt) and `[TOOLCALL]` parsing (`:3644`, also `subagent.py:810`) even on native-tools models. | Reset at turn start or in the `else` branch of `_applyModelCapabilityProfile`. |
| 1.2 | `tool_guardrails.py:104-146` | `_alternating_run` compares tool **names** (`seq[-1][0]`), not `(name, args-hash)` as its docstring says. The motivating case (`read_file(a)/read_file(b)` ping-pong) can never trip; the normal productive `edit_file ↔ run_command` loop — different args every time — counts as alternating and hits `BLOCK_ALTERNATING = 10` (`:43`), blocking the 5th edit/test cycle. | Key tones by `(name, argsHash)`. |
| 1.3 | `tool_guardrails.py:70-86,152-160` | Cross-turn identical-call strikes never decay: every turn's calls join `_priorTurnCalls` permanently; `_crossTurnStrikes[key] >= 2` → hard block. A stable command (`pytest -q`, `git status`) re-issued once per user turn is BLOCKED on turn 3 despite every prior run succeeding — `check()` has no outcome signal. | Clear a key's strike on non-error result, or expire `_priorTurnCalls` on `record_user_message`. |
| 1.4 | `workbench/providers.py:829-830` | OpenAI workbench path **appends** streamed tool names (`existing['name'] = as_str(...) + as_str(fn.get('name'))`) — the exact bug the proxy accumulator fixed with set-once (`adapters/stream_state.py:50-54`: "some providers re-send it with every chunk"). Gateways that resend names produce `web_searchweb_search…` → unknown-tool failures in the workbench only. | Set-once, mirroring `stream_state.py`. |
| 1.5 | `providers/clients/base.py:572-578,653-659` | Internal `upstreamRetry` SSE events leak to `/v1` API clients: the workbench filters it (`providers.py:493,704`) but the proxy pass-throughs don't (`adapters/anthropic.py:925`, `adapters/openai.py:423-424`). On any pre-first-token 429/503 retry, SDK-style clients receive a non-standard event/chunk. | `continue` on `type == 'upstreamRetry'` in both proxy loops. |
| 1.6 | `workbench.py:3153-3182` | Ceiling early-return emits `error` but no `done`; the comment at `:3171-3174` claims "the finally below emits the done event" — that `finally` (`:4937`) belongs to a different `try` and is unreachable from this `return`. Other early exits (`:2556,:2676,:2721`) do emit `done`. | Emit `done` or fix the comment. |
| 1.7 | `workbench.py:88` | `max(30, int(os.environ.get('AUGUST_TOOL_TIMEOUT_S','300')))` at module import — a non-numeric value raises `ValueError` and takes down the whole workbench. | try/except fallback to 300. |
| 1.8 | `workbench.py:6017` | Worker todo receipt counts `status == 'completed'` only; every other renderer (`:1418,:1454`) also accepts `done`. Workers using `done` get "0/N done" receipts. | Accept `done` too. |
| 1.9 | `subagent_orchestrator.py:363-370` | *(resolved: verified verbatim)* "Enforce per-call concurrency cap" is a bare `logger.info`; the real gate is the global 5-slot semaphore (`:327,695`) shared across sessions. A session set to `maxConcurrent: 2` runs up to 5; one set to 30 is capped at 5. | Per-session semaphore (or `min(per-session, global)`). |

---

## Phase 2 — Scope isolation & Bot Mode correctness (P2)

The M-2 home-isolation rule is honored by the per-turn `<memory>` block but broken at four other
doors; the just-landed Bot Mode Phases C/D carry three functional bugs.

| ID | File:line | Finding | Fix |
|----|-----------|---------|-----|
| 2.1 | `memory_store/brain.py:596-601` | `brain_index_snippet` (frozen per-session boot index) selects `FROM facts ... ORDER BY updated_at DESC LIMIT 15` with **no scope clause** → a Bot's private `bot:<id>` fact names are injected into every other session's system prompt, and vice versa. | Add `AND (scope IS NULL OR scope='global' OR scope=?)` with the session's resolved scope. |
| 2.2 | `memory_store/rest.py:136-164` + `session_tools.py:536` | `list_facts` / `search_facts` have no scope filter, no `status='active'` filter, no expiry filter → a Bot sees every other Bot's private keys/titles plus superseded/retired/expired rows. (`forget` correctly re-checks scope at `session_tools.py:475-488` — read leak, not delete leak.) | Filter scope-union + status + expiry. |
| 2.3 | `session_tools.py:82-87` + `rest.py:60-85` | `_deriveFactKey` produces `model:<slug>` with no scope prefix, and `fact_key` is globally UNIQUE with `ON CONFLICT(fact_key)` upsert that never rewrites `scope`. Two Bots saving the same text derive the same key; the second write silently overwrites the first Bot's private row — which the writer cannot even see. | Namespace derived keys by scope, or conflict target `(fact_key, scope)`. |
| 2.4 | `rest.py:60-85` | `save_fact` upsert's `DO UPDATE SET` list omits `status` → re-remembering a superseded (`consolidation.py:389-393`) or retired (`:266-269`) key updates the value but leaves it filtered out of `_load_index` (`fact_retrieval.py:110`) forever. The model believes it saved. | Reset `status='active'` in the upsert (or CASE on retired/superseded). |
| 2.5 | `consolidation.py:280-401` | `_load_active_facts` has no scope filter; `_merge_duplicates`/`_supersede_contradictions` can fold a **global** fact into a bot-scoped row (deleting the global row → global memory vanishes for all sessions) or supersede across scopes. `find_similar_facts` is called with default `scope='global'` (`:336`) while iterating all-scope facts. | Partition merge/supersede passes by scope. |
| 2.6 | `consolidation.py:91-104` + `brain.py:660-727` | Fact index not invalidated on TTL expiry (`_expire_facts` deletes rows; invalidation only fires when merged/superseded non-zero) nor on Settings-UI edits/deletes (`brain_delete_row`/`brain_update_row`) → stale facts keep being injected from the cached BM25 corpus until an unrelated write clears it. | `invalidate_fact_index()` in all three paths. |
| 2.7 | `routers/privacy.py:168-188` | "Erase my memory" runs `DELETE FROM facts` but never invalidates the cached corpus → purged facts keep being injected until the next write. Privacy hole. | Invalidate after the delete. |
| 2.8 | `migrations/023_memory_hygiene_purge.sql:18` | `DELETE FROM auto_memories;` runs after `create_core_schema` stopped creating the table (`memory_schema.py:125-130`) → on every **fresh** DB, 023 records "no such table" in `schema_migration_failures` (`lib/migrations.py:106-122`) and aborts its remaining purges (`:20-33`). | Guard with `WHERE EXISTS (SELECT 1 FROM sqlite_master ...)` or drop the statement (033 removes the table anyway). |
| 2.9 | `bot_mode/dm.py:371,379` | DM sender-wake message appended twice: manual `sender.messages.append(...)` + `save_sessions()`, then `_run_turn` → `sendWorkbenchMessageStream`, which appends the user message again (`workbench.py:2560`). The Phase-C test hides it because its `fake_runner` doesn't append (`tests/test_bot_mode_phase_c.py:131-134`). | Drop the manual append (mirror `automation_memory.deliver_to_bot_chat:461-463`). |
| 2.10 | `bot_mode/rooms.py:394-410` | G-1 review round: `review` is consumed at end-of-round (`review = None; speakers=[reviewer]`) **before** the reviewer speaks, so `is_verdict` is always False in the review round → the reviewer's verdict is stored `kind='message'`, and `verdict_wants_changes`/revision (`:396,403-404`) never fire. In the primary flow no `verdict` row is ever written. | Carry a `pending_verdict_for` id into the next round instead of clearing `review`. |
| 2.11 | `bot_mode/routines.py:156-178` | `delete_routine` bare-title match scans **all** `[bot:*]` jobs without restricting to the caller's namespace → Bot A can delete Bot B's same-titled routine. | Require `[bot:<caller>]` prefix for bare titles. |
| 2.12 | `post_observation.py:89-94` | `capture_after_tool` is a no-op: `path` is computed but the write is `Path(shot['path']).write_bytes(Path(shot['path']).read_bytes())` — reads and rewrites the **source** file, never creating `path`. `count_observations()` (`privacy.py:87`, `host_agent.py:23`) is permanently 0. | `path.write_bytes(...)`. |
| 2.13 | `routers/agents.py:306-312` + `bot_mode/roster.py:165-170` | `delete_bot` removes only the registry record: `bot_dm` rows, `bot_room.members`, the canonical Bot Chat session, and all `facts` with `scope='bot:<id>'` survive indefinitely — a deleted Bot's private memory and DM history remain in the DB. | Cascade-delete scope + inbox + room membership + session. |
| 2.14 | `episode_miner.py:622` | `capCount = int(len(scored) * flagRateCap)` floors to 0 for any pass with <20 unscored episodes; since each pass drains the unscored set, typical desktop installs **never** escalate anything to tier-2 review. | `max(1, ...)` when `scored` is non-empty. |
| 2.15 | `tools/skill_tools.py:35,55-58` vs `workbench.py:3070,1212` | Bot private skills advertised but not loadable: the per-turn `<relevant_skills>` block is built with the bot root (`build_relevant_skills_block(..., bot_agent_id(_turnScope))`) and says "Load one with load_skill(name)", but `load_skill`/`list_skills` resolve **without** `agent_id` → "not found". Phase E read door is half-wired. | Thread the resolved `bot_agent_id` into the skill tools and the Tier-1 catalogue call. |
| 2.16 | `project_memory.py:184-186` | `_sanitizeBody` regex `re.sub(r'^##(\s)', r'\\\1', ln)` replaces the two hashes with a backslash → `## Heading` becomes `\ Heading`; silent content loss, no unescape on parse. | Escape properly (`\##`) or drop the rule. |
| 2.17 | `episode_miner.py:645-651` | `created_at >= since` compares space-format rows against ISO `T`-format `since`; on the cutoff day space (0x20) sorts before `T` → that day's messages excluded. | Normalize both sides to one format. |
| 2.18 | `gateway/session_bridge.py:195-199` | `invokeAgent` skips `trace.finish()/clear_current()` when `_runner` raises (no try/finally) → stale current-trace leaks on the thread. | try/finally. |
| 2.19 | `consolidation.py:196-208` | `_retire_stale_preferences` dedupes only `status='pending'` proposals → a human-**rejected** retire re-files every pass (the §12 F-8 pattern the distiller already fixed). | Dedupe across all statuses. |

---

## Phase 3 — Frontend correctness (P2)

### 3.1 The `session` SSE event is never emitted → ChangesCard is broken — P2
*(resolved: verified — `grep` finds no `emit({'type':'session'})` nor `event_log.append(sid,
'session', ...)` anywhere in `backend-py/app/`.)*
- `frontend/desktop/src/api/workbench/streamEvents.ts:112` `case 'session'` → `onSession`
  (`makeStreamHandlers.ts:525-540`) is the **sole** writer of `latestMutationCount` (`:536`) and
  `latestWorkbenchTodos` (`:535`). The post-turn git-diff fetch is gated on
  `latestMutationCount > beforeMutationCount` (`:843`) — with `onSession` dead and
  `beforeMutationCount` 0 in the composer path, the gate is `0 > 0` forever, so the only
  assignment of `message.changedFiles` (`:845-851`) never runs.
- Consequence: `ChangesCard.tsx:183` `isCodeRow` is always false → edited code files render as
  document letter-badges, the **Review button (`:264`) never appears**, and ±added/removed
  (`:63-69,143-155`) never show. Tests mask it by passing `changedFiles` directly
  (`ChangesCard.test.tsx:140,174`).
- **Fix:** derive mutation count from edit-classified `toolResult` blocks (or fetch the diff
  whenever any edit tool ran this turn). **Test:** integration-style handler test driving real
  event shapes (no `session` event) and asserting `changedFiles` populates.

### 3.2 `onRetrying` wipes all prior rounds' output — P2
- `makeStreamHandlers.ts:870-874` clears `assistantContent`/`thinkingContent` and filters all
  thinking/finalOutput blocks. But `retrying` is emitted **inside the per-round retry loop**
  nested in the `while True` tool loop (`workbench.py:3204→3302/3343`, emits at
  `:3320,3494,3522`), so a round-2+ transient retry erases round-1 committed prose that the
  retry does not re-stream. Contrast `onUpstreamRetry` (`:877-888`), which deliberately does no
  rollback.
- **Fix:** snapshot block length at attempt start; roll back only blocks added during the failed
  attempt.

### 3.3 "Chat failed → Retry" re-sends the annotated text — P2
- `useChatSend.ts:286` `onClick: () => void send(requestText)` passes `requestText`, which
  already contains the `@git` context block (`:239`) and the Bot-Mode `@mentions` note (`:250`).
  `send()` re-runs both annotators on it (`:237,:246`) → second git block + second bot note (the
  note itself contains `@handle`, which `resolveBotMentions` re-resolves); each retry compounds.
  Secondary: `send` is captured in the closure but missing from the dep array (`:299-308`) →
  stale-closure retry.
- **Fix:** retry the clean `latestText`; reference `send` via a ref.

### 3.4 Bot @-mention autocomplete is unwired — P2 (uncommitted-feature gap)
- `composer-mentions.ts:195` defines `fetchBotMentions` and `:15` adds `kind:'bot'`, but
  `useComposerPopovers.ts:168-215` fetches only skills/mcp/files/conversations/harness —
  `fetchBotMentions` has **zero callers** (verified) and no dropdown branch renders
  `kind==='bot'`. Manual `@bot` + send still annotates; bots never appear as suggestions.
- **Fix:** add the fetch effect + merge into `mentionItems`, reusing the `getBotRoster` cache.

### 3.5 Minor frontend fixes — P3
- **3.5a** `PrivacySection.tsx:216` "Purge memory" description under-reports: backend also wipes
  all `memory_store` KV rows except `agent_registry/agent_jobs` (`privacy.py:_KV_KEEP_KEYS`) —
  the KV "Memories" notes are erased too. Update copy.
- **3.5b** `SettingsPage.tsx:336,338,339` map `tool-grants`, `python-sandbox`, `agent-sandbox`
  all to `AccessHubSection`, which ignores `active.id` (`AccessHubSection.tsx:8`) — three rail
  entries render one identical page while the registry advertises distinct labels
  (`settings-registry.ts:497-526`). Branch on `active.id` or merge the entries.
- **3.5c** `turnTelemetry` is silently dropped: `api/schemas/workbench.ts:296` claims it is
  "handled in streamEvents.ts", but `streamEvents.ts` has no such case → the cache-hit/latency
  chip never renders (`workbench.py:4811` emits it). Add the case or delete the claim.
- **3.5d** `MemorySection.tsx:744-746,758-759,774-775,807-808` duplicate `setUnifiedOffset(0)`
  calls (copy-paste noise).

---

## Phase 4 — The auto-routing corpse (consolidated decision item)

Four agents independently hit pieces of the same story; consolidated evidence:

- **No writer:** `routing_evidence` is referenced only by the privacy purge list
  (`privacy.py:45`) and a stale comment (`sessions.py:109`) — *(resolved: the cross-cutting and
  frontend agents' "written internally" notes were wrong; verified by grep)*.
- **No emitter:** no `routingSuggestion` SSE producer in `backend-py/app` (exists only in stale
  installer copies under `src-tauri/target/**/resources/backend-py/`).
- **No endpoints:** `/api/brain/routing/arena` and `/routing/suggestions` do not exist, yet the
  live UI calls them: `ArenaView.tsx:88,236`, `DebateView.tsx:88` (POST → `toast.error('Could
  not record verdict')` **every time a debate winner is picked**), `useChatSend.ts:609`,
  `ArenaLaunchModal.tsx:83` (GET → 404 swallowed).
- **Unread config:** `autoRoute`, `autoRouteMinWinRate`, `autoRouteWinGap` registered
  (`brain_config_service.py:98-101`), typed, validated — never read (`autoRouteMinSamples` is
  read, by `harness_self_improve.py:148`). `sessions.py:111 _auto_routed` never set/read.
- **Unreachable flag:** localStorage `august_auto_route` is only ever written `'0'`
  (`useChatSend.ts:637`); no UI sets `'1'`.
- **Docs claim it live:** `AGENTS.md` ("Routing evidence records real outcomes… auto-routes with
  `AUGUST_AUTO_ROUTE=1`") and `docs/CONFIGURATION.md:373` — the env var was removed in
  `4f1bfdb1`.

**Recommendation (split verdict):**
1. **Delete** the auto-route remnants: 3 brain-config keys, `_auto_routed`, the
   `august_auto_route` localStorage block, and correct `AGENTS.md` + `CONFIGURATION.md`.
2. **Keep Arena/Debate** (live, user-facing) and give them the missing backend: a thin
   `POST /api/brain/routing/arena` + `GET` history backed by the existing `routing_evidence`
   table (already covered by the privacy purge). This also stops the Debate error toast.
   *Alternative if you'd rather not resurrect it: hide the Arena/Debate entries and delete the
   call sites.*

Also in this phase: the 8 remaining **accepted-but-never-read** brain-config keys —
`adaptivePolicy`, `failureLearning`, `graphMemory`, `agentJobs`, `hierarchicalAgents`,
`adapterParallelTools`, `parallelReadTools`, `reviewLearnedGuidelines`
(`brain_config_service.py:81-101`; repo-wide grep: zero `.get()` consumers; the `agent_jobs`
hit is an unrelated KV key, `adapter_parallel_tools` lives in a different cognitive-features
namespace). **Recommendation:** drop from `fieldTable` (aspirational flags that mislead the
Settings UI into offering dead toggles).

---

## Phase 5 — Performance

### 5.1 Durability barriers re-serialize the full transcript on the event loop — P2 (biggest win)
- `workbench/durability.py:45-54`: `session.toDict()` + `save_workbench_session_sot()` (sync
  SQLite) run at every model dispatch (`workbench.py:3331`), **every top-level tool** (`:4145` —
  each member of a parallel read batch flushes separately), and every step boundary (`:4690`).
  O(transcript) × O(1+tools) per round; a 500-message session pays 10+ full JSON snapshots per
  round, synchronously.
- **Fix:** version-counter on the working copy (skip flush when unchanged since last barrier)
  and/or run the write in an executor. **Measure:** TTFT telemetry (`030` early-dispatch) before
  / after on a long session.

### 5.2 Loop-body recomputation — P3
- `workbench.py:3295-3300`: `_modelRetryPolicy()`, `_chatFallbackChain()`,
  `_chatContextPromotionModel()` (each a config/fleet walk) sit inside `while True:` — hoist
  above the loop. (`promotionUsed = False` at `:3301` also resets per round, so "promote once"
  is really "once per round".)
- `workbench.py:1733-1754`: `_modelCapabilityProfile` re-scans providers×models per tool result
  (`:4584`) plus both tool-def paths — cache on the session per turn.
- `providers.py:509-510,794-795`: stream-rule regexes rescan the whole accumulated text on
  **every** SSE event (incl. pings) — O(n²) over long outputs; after a tool cancels the hit
  (`:511-512`) the next event re-matches identical text. Scan a bounded tail window, once per
  content block.

### 5.3 Memory/skills retrieval waste — P3
- `episode_miner.py:643-662`: `mine_sessions` fully loads and re-parses 30 days of transcripts
  every 24 h consolidation tick (dedupe prevents re-inserts, not the daily full re-parse).
  Track a per-session last-mined message id.
- `rest.py:159-163` `list_facts` SQL has no LIMIT (capped only in Python at
  `session_tools.py:563`); `rest.py:455-472` `get_usage` returns every event for a session with
  no LIMIT plus a 4th per-event cost query (N+1).
- `skill_service.py:457,459`: `catalogue()` runs `list_all()` twice; `fact_retrieval.py:326,328`:
  `build_memory_block` calls `search_entries` twice per turn; `skill_service.py:400`:
  `load_bodies` N+1 (full directory scan per name).

### 5.4 Transcript bloat & disk growth — P3
- `workbench.py:2955-2956` says the tail blocks are "Working-copy only (never persisted…)" but
  the patched last-user message (memory/skills/session_state/nudge tail, `:3080-3082`) **is**
  written to `session.messages` at `:4839` — every turn's tail rides in history forever (bloat +
  stale `<session_state>` blocks the model may trust). Strip tail blocks before persist, or
  correct the comment if intentional.
- `system_tools.py:145` + `workbench.py:1497-1501`: scratchpad stores raw text and injects it
  verbatim every turn — cap (e.g. 4 KB) with an elision marker.
- `workbench.py:361-388`: `.aug/spill/` writes one file per oversized result with no cleanup on
  compaction or session delete — unbounded workspace disk growth.
- Never-pruned tables: `failure_fingerprints` (`prune_old_episodes` at `episode_miner.py:665-671`
  deletes only `episodes`), `bot_dm`, `bot_room_message`.

### 5.5 Frontend render churn — P3
- `ChatThreadMessagePane.tsx:195`: `MessageBubble` is not memoized (only `ThinkingDisclosure`
  and `ToolCallItem` use `memo`) and renders inside an inline `renderMessage` arrow → every
  32 ms `update()` flush (`makeStreamHandlers.ts:206-221,73`) re-renders all visible rows.
- `AssistantBlockTimeline.tsx:356-361`: a 1 s `setNowMs` interval re-renders the entire
  process-timeline subtree each second — isolate the duration label.
- `useStickToBottomScroll.ts:152-186`: the wheel/touch/key listener effect lists
  `messagesVersion` (= the `messages` array) in deps → tears down and re-adds 5 listeners on
  every flush.

---

## Phase 6 — Dead-code purge (P3, mechanical)

### 6.1 Orphan service modules (~700 lines; verified zero production importers)
| Module | Lines | Sole reference |
|--------|-------|----------------|
| `services/guidance.py` | 126 | `tests/test_phase5_features.py:7` |
| `services/automation_gate.py` | 76 | same test |
| `services/provider_detect.py` | 43 | same test |
| `services/project_readiness.py` | 309 | `guidance.py` + `test_phase4_features.py` |
| `services/august_api.py` | 35 | none (stale hardcoded `'version': '0.12.0'` at `:14`; `AuditTimeline.tsx:17` still lists `august_api` as an audit category nothing emits) |
| `services/system_tools.py` | 109 | none — distinct from the live `tool_registrations/system_tools.py` |

Delete the six modules + `test_phase4/5_features.py` (the "Phase 4/5 readiness/guidance" cluster
is orphaned wholesale). Note: the 33 other suspect services checked (harness_jobs/ops/playbook/
promote/self_improve/mode, feature_flow, exam_service, blackboard, cognitive_boot/config,
daemon_manager, live_speech, realtime_bus, …) are all **live** with import evidence — no further
orphans.

### 6.2 Dead mounted routers (zero callers in frontend/desktop, mobile, scripts, src-tauri)
- `routers/cron.py:38-82` (6 endpoints), `routers/daemons.py:16-48` (3 — the *service* is live
  via `cognitive_boot`/tools; only the router is dead), `routers/hooks.py:10,16` (2),
- `routers/refine_store.py:49-155` (11 — service live via `workbench.py:1288`; router dead),
- `routers/terminal.py:30-69` (legacy REST 6 — the live surface is `terminal_routes.py`).
- **Recommendation:** delete the five routers; keep `/api/gateway/pairing*` (`gateway.py:122-153`)
  — backend-first Part 20 Phase 0 surface awaiting its FE UI, genuinely open, not dead.

### 6.3 Dead individual endpoints (~35; full list verified by grep)
`agents.py:472,486,491` (jobs*) · `audit.py:114` · `august.py:76,97,690,712` ·
`brain_config.py:70,195,205` (+ FE helper `api/workbench.ts:490` zero callers) ·
`config.py:78,123,288,297,305,316,370,378` · `desktop_automation.py:130` ·
`harness_proposals.py:57,74` · `mcp.py:38,227,175,209` · `monitoring.py:54,277` ·
`providers.py:75,335,504,525` · `realtime.py:49` · `recurring_tasks.py:55` ·
`security.py:214` · `subagent.py:199,223,376,306` · `terminal_routes.py:112` · `usage.py:23` ·
`workbench.py:367,800,890,1314,1322,341` (superseded duplicates: FE uses singular status alias,
`/chat/queue` kind=steer, PATCH title, etc.).
**Recommendation:** delete only the superseded duplicates (`workbench.py:367,800,341`,
`august.py:76,97`, `terminal_routes.py:112`, `usage.py:23`); keep the rest as deliberate
API surface (proxy/MCP/external) unless you want a hard purge.

### 6.4 Dead code inside live modules
- `capabilities_prompt.py:50-190`: the bucket frozensets (`_TOOL_READ/_TOOL_WRITE/...`) are
  never read — `classify_tool` (`:195-201`) delegates to `tool_policy.prompt_bucket` — **and
  have drifted** from the live sets (missing `analyze_media`, all `circuit_*`, `forget`,
  `apply_patch`, `job_notes`, `harness_introspect`). Editing them silently changes nothing.
- `capabilities_prompt.py:420` `_SKILL_RELEVANCE_LIMIT = 8` — zero references (live knob is
  `_RELEVANT_SKILLS_TOP_K = 3` at `:551`).
- `workbench/prompt_cache.py`: Tier-1/2 LRU vestigial — `get/set/invalidate/stats` never called
  in production, only `.clear()` (`workbench.py:814`, `skill_service.py:522`);
  `prompt_segments_cache.py:101` even claims "`prompt_cache.stats()` is the live instrument" —
  it isn't. Delete module + clear-hooks + fix comment.
- `workbench.py:1548-1552`: `AUGUST_AUTO_PROFILE` comment block describes removed code.
- `tool_registry.py:17,80-81`: `_RESERVEDNames = frozenset()` → the `raise` can never fire;
  `:43-49` `setDaemonContext(pollInterval=…)` accepted but never stored despite the docstring.
- `workbench.py:6267-6296`: `tool_policy.py:5-11` claims it replaced
  `listProxyCapabilities._MUTATING_TOOLS`, but the private drifted copy remains (missing
  `apply_patch`, `circuit_*`, `create_routine`…); `:6325` groups `'toolCall'` (camel) while the
  registered name is `tool_call` → bridge tools mis-grouped as `other`.
- `bot_mode/dm.py:112-125` `list_inbox` — zero callers (the durable-inbox read surface the 034
  comment implies was never wired). `bot_mode/protocol.py:45-51,86-99` `mention_note` — no
  backend caller; the frontend hardcodes a duplicate (`composer-mentions.ts:175-185`), so the
  "render from one place" invariant is already drifting. `skill_service.py:278-282,488-491`
  `skill_body`/`isEnabled` — test-only. `memory_store/wire.py:12-16` `_q` — no callers.
  `background_review_service.py:29` `enabled` flag — written and surfaced, gates nothing.
- Writerless tables still created/cleared: `tool_guardrail_log` (`memory_schema.py:269`; no
  INSERT anywhere; `episode_miner.py:6` docstring falsely lists it as a mining source),
  `consolidation_audit` (005), `friction_events` (003) — cleared by `privacy.py:62-69` but never
  written; `brain_events` is in `_LOG_TABLES` (`privacy.py:66`) yet was dropped by migration 025
  (the DELETE silently fails).
- `035_bot_rooms.sql:5-7` + `bots.ts:106` advertise a `review` kind `rooms.py` never writes
  (only message/pass/verdict/escalation).

### 6.5 Dead frontend code
- Orphan components (zero production importers, verified): `components/chat/RecapCard.tsx:62`,
  `HarnessJobStrip.tsx:26`, `WorkstreamsPanel.tsx:20`, `SubagentExpandedCard.tsx:51`,
  `sections/chat/CalendarCard.tsx:53` (test-only), `components/chat/ToolSummary.tsx:72`
  (test-only). *(resolved: the cross-cutting agent's R-02 "Save skill button is visible" was
  wrong — the panel containing it is itself orphaned, so the missing
  `/api/subagents/workstreams/{name}/save-skill` route (`api/subagents.ts:325`, plus
  zero-caller `:349`) is unreachable; deleting the panel resolves it.)*
- `hooks/useSystemHealth.ts:24` — no importers **and** targets nonexistent
  `/api/brain/health`; `SystemHealthSection.tsx:150` correctly uses `/api/health/detailed`.
- `makeStreamHandlers.ts:165,406,412` `pendingConfirmations` — written, never read.
  `:356-357` `thinkingEnd` set on the **first** delta → `thinkingDuration` (`:279-283`) ≈ 0 and
  is never displayed anyway.
- `ChatLayout.tsx:100` removes localStorage key `august-show-right-sidebar` never set/get;
  `composer-mentions.ts:163` `handle.includes('@')` — the capture regex `[\w.-]+` can never
  contain `@` (dead branch).
- `streamEvents.test.ts:4` `modelProfileSuggestion` SSE case — never emitted by the backend
  (suggestions ride the REST probe `routers/providers.py:677-690`).

### 6.6 Repo junk
- `Screenshot 2026-08-26 163730.png`, `Screenshot 2026-08-26 192236.png` are git-tracked at the
  repo root — `git rm`.

---

## Phase 7 — Docs, config & test hygiene (P3)

- **7.1** `AGENTS.md` corrections: auto-routing paragraph (Phase 4), `MAX_MANAGED_TOOL_ROUNDS`
  claim is now true (verified: `features.py` carries no override; the 25 fallback seeds brain
  config — keep), but "Loop-level golden evals live in `tests/test_harness_evals.py` … results
  feed `GET /api/brain/harness/evals`" is false — both gone (only a stale `.pyc` remains);
  mode list says `chat|agent|code` but `set_agent_mode` also accepts `orchestrator|planner`
  (`system_tools.py:426-443`, prompt `workbench.py:2788-2796`).
- **7.2** `docs/CONFIGURATION.md`: remove `AUGUST_AUTO_ROUTE` (`:373`) and
  `AUGUST_DB_WRITER_LOW_DROP_S` (`:368`) — never read; document the ~37 AUGUST_* vars that ARE
  read but undocumented (`AUGUST_ENABLE_DOCS`, `AUGUST_CORS_ORIGINS`, `AUGUST_HEADLESS`,
  `AUGUST_PERF_TIMING`, `AUGUST_SKILL_RELEVANCE`, `AUGUST_SUMMARIZING_COMPACTOR`,
  `AUGUST_WARM_KERNEL_OFF`, `AUGUST_EVENT_LOG_SYNC`, `AUGUST_SANDBOX_APPCONTAINER`, timeout
  knobs, toolchain paths `AUGUST_QUARTUS_SH/MODELSIM/GHDL/AVR_GCC/KICAD_CLI/NGSPICE_EXE`);
  drop documented-but-never-read `AUGUST_API_TOOLS`, `AUGUST_PLATFORM`, `AUGUST_PROXY_URL`,
  `AUGUST_SECRET_KEY`, `AUGUST_P1_PROMPT_CACHE`.
- **7.3** Stale plan headers: `docs/plans/2026-08-29-self-improvement-loops.md:3` claims no
  `episode_miner.py`/028 — all exist now;
  `docs/plans/2026-08-28-circuit-workbench-eda-deep-dive.md:3` claims ModelSim/GHDL "still
  UNCOMMITTED as of 2026-09-03" — committed in `cb626b40`. `2026-09-01-memory-enhancements.md`
  ruling-record line refs have all shifted (e.g. `_supersede_contradictions` now
  `consolidation.py:369-401`).
- **7.4** Test rot: `test_phase_p_exit_gate.py:26` locks retired `auto_memories_fts` into
  `KNOWN_FTS` (`scripts/_check_fts_query_hygiene.py:51`) and `:74` enforces docs for the dead
  `AUGUST_P1_PROMPT_CACHE` knob; `test_fts_repair.py:102-103` drops `auto_memories_fts` to
  "simulate a partial DB" — now vacuous. Update all three with the 033 retirement.
- **7.5** `system_tools.py:329` `update_state` description still says state is "injected into
  the next turn's system prompt" — Phase L moved it to the `<session_state>` tail on the last
  user message (`workbench.py:1151-1165,1475-1509`). Stale guidance for the model itself.
- **7.6** `maxWorkbenchToolLoops` 0-disable is unreachable from the UI:
  `_managedToolLoopCap` treats 0 as "disable cap" (`workbench.py:577-580`) but the brain-config
  range is `(1, 500)` (`brain_config_service.py:72`). Align one way.
- **7.7** `backend-py/pyproject.toml:3` `version = "0.1.0"` never bumps (intentional — backend
  reports via `app/version.py` reading root package.json) but it's an 8th version-looking file
  outside the sync check — add a comment. `settings-registry.ts:6` header says "38 sections";
  the array holds 43. `AssistantBlockTimeline.tsx:40-42` comment says "last 3 lines", constant
  is 6. `api/schemas/workbench.ts:277-278,341-342` truncated dangling comments.

---

## Verified clean (coverage — what the scans checked and found correct)

- **Upstream serialization:** `dump_openai_upstream_body`/`dump_anthropic_upstream_body`
  exclude_none + August-key strip, `user`/`metadata` preserved (`models/openai.py:59-72`,
  `models/anthropic.py:53-67`) — matches the 0.12.21 fix.
- **`AnthropicNativeStreamState`:** per-block-index fragment store, malformed JSON → `{'_raw'}`
  never `{}`, `signature_delta` lands on the open thinking block (`stream_state.py:227-311`).
- **Retry discipline:** quota fail-fast + deterministic-400 ordering (`workbench.py:175-265`);
  partial-emission retry guard (`:268-274`; `base.py:543-663`) — mid-stream failure never
  replayed.
- **Prefix-cache discipline:** byte-stable `<session>` block, frozen per-session indexes,
  memoized harness digest, cache breakpoints re-applied after tools/messages final
  (`workbench.py:1064-1221`; `providers.py:468-472`). (The 2026-08-29 cache-bust regression is
  genuinely fixed.)
- **Stall detector / malformed-JSON self-heal / narration deferral:** all match AGENTS.md
  claims (`workbench.py:3221-3267,3873-3909,4612-4657`; `providers.py:505-528,790-859`).
- **Warm kernel / code mode:** lock-before-warm, bridge token revoked in `finally`, 900 s
  self-reap (`workbench.py:2327-2345`; `kernel.py:78,158-178`).
- **Verifier removal:** zero hits repo-wide.
- **Migrations 032-035:** warm/cold ordering correct; 033 idempotent; DDL matches `dm.py`/
  `rooms.py` INSERTs; `auto_memories` readers all gone (except the Phase-7.4 test locks).
- **Memory core:** `repair_fts_sync` desync detection (`memory_schema.py:506-529`), FTS-branch
  filter ordering (`brain.py:403-415`), per-turn `<memory>` scope-correct + cache-safe
  (`workbench.py:2998-3005`), UPSERT-not-REPLACE SOT save (`sessions.py:98-129`), deferred
  writes off-loop correctness, `filter_dm_tools` wired into BOTH tool-def paths, sensitive-topic
  denylist on both doors, 24 KiB skills budget stop-packing, cron DST semantics, §12 episode_miner
  fixes, `turn_outcomes` promotion.
- **Frontend core:** settings-registry audit test green (unique ids/aliases, all `/settings/<id>`
  links resolve, 5 stubs documented); SSE frame parser, session-stream-store LRU/tombstones,
  start/stop controller lifecycle carefully written; `toolResult` status derivation matches
  backend; uncommitted memory/privacy edits consistent with backend stores.
- **Repo hygiene:** version sync green (7 files @ 0.17.0); no tracked build artifacts; signing
  key gitignored; all 43 routers mounted; config_service/live/web namespaces non-overlapping.

---

## Execution order & effort

| Phase | Items | Est. effort | Gate |
|-------|-------|-------------|------|
| 0 | 4 | ~half day | targeted tests + headless-turn integration test |
| 1 | 9 | ~1 day | test-first per guardrail/stream fix; `ruff + mypy + pytest -q` |
| 2 | 19 | ~1.5 days | scope-leak tests per door (bot A vs bot B vs global); migration 023 fresh-DB test |
| 3 | 4 + 4 minor | ~1 day | handler tests with real event shapes (no `session` event); vitest + tsc |
| 4 | decision + 11 keys | ~half day after ruling | grep-zero for removed symbols; arena endpoint test |
| 5 | 5 groups | ~1 day | TTFT/flush-count before/after on a 500-msg session |
| 6 | ~2,500 lines | ~half day, mechanical | full suite green after deletions |
| 7 | 7 | ~half day | docs-only + test updates |

Suggested batching: **0+1+2 as the correctness batch** (they share the bot-mode/scope surface),
**3+4 as the frontend batch**, **5+6+7 as the hygiene batch**. Phase 4's Arena/Debate verdict is
the only item that changes user-facing scope; everything else is fix-or-delete with no product
decision required.
