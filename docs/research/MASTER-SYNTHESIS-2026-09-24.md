# Master synthesis — August harness & desktop deep dive

**Date:** 2026-09-24
**Scope:** 4 reference repos + 4 audits of August itself (backend harness, subagent
output path, desktop UI, app lifecycle).
**Evidence base:** 5,770 lines of cited reports in this directory.

| Report | Lines | Subject |
|---|---|---|
| `hermes-agent-deep-dive.md` | 1606 | NousResearch hermes-agent |
| `oh-my-pi-deep-dive.md` | 978 | can1357/oh-my-pi |
| `minimax-cli-deep-dive.md` | 853 | MiniMax-AI/cli |
| `deepseek-harness-deep-dive.md` | 806 | deepseek-ai/deepseek-harness |
| `august-subagent-output-audit.md` | 506 | August — output-loss bug hunt |
| `august-frontend-ui-audit.md` | 392 | August — desktop UI |
| `august-lifecycle-audit.md` | 333 | August — launch/update/close |
| `august-backend-harness-audit.md` | 296 | August — loop/memory/learning |

---

## 0. TL;DR

**Your subagent bug is real, and I found and fixed the root cause.** It was not one
bug but two, plus a latent third:

1. **The worker threw away the answer.** `subagent_worker.py` returned only the
   `error` string whenever a subagent reported anything other than `completed` —
   discarding `result`. A subagent that hit the loop cap after doing substantial
   real work reported `[loop cap reached]` to the parent, and persisted an empty
   `result_full`. **Fixed.**
2. **The wake was one-shot.** A completion landing after the parent turn's *last*
   queue drain found the turn still live, so the wake gave up, and nothing
   re-armed it. The result sat in the queue until you sent an unrelated message.
   **Fixed.**
3. **The cap was silent.** After 4 consecutive auto-turns every later completion
   was dropped with no signal. **Fixed** — it now emits a handled event.

Two more confirmed bugs fixed along the way: an unbounded prompt-growth bug
leaking one session's tool inventory into every other session, and no chat render
path for subagent output at all.

**The single most valuable structural idea** across all four reference repos is
**synthetic tool-result pairing** (oh-my-pi) — every emitted `tool_call` must get
exactly one matching `tool_result` on every exit path, or strict providers 400.
August has no equivalent choke point. That plus a **replay-safety veto on retry**
(the highest-value correctness idea found) are the two I'd do next.

---

## 1. What I fixed this session

All three fixes are mutation-tested: each test was confirmed to **fail against the
old code** and pass against the new.

### F1 — Subagent output preserved on every non-clean exit (P0)

**File:** `backend-py/app/services/subagent_worker.py`

`executeSubAgent` puts a capped run's entire accumulated answer in
`subResult['result']` under status `partial`. The worker discarded it. The
orchestrator's dedicated `partial` branch was **dead code** as a direct
consequence — the status could never arrive.

```
before:  status != 'completed'  ->  return {'status': 'failed', 'error': ...}   # result dropped
after:   status != 'completed'  ->  return {'status': status,   'error': ..., 'result': resultText}
```

This also revives the honest failure tallies (`partial` ≠ `completed`) and means
failed/cancelled runs can still surface partial work.

**Tests:** `tests/test_subagent_worker_output_preservation.py` (6 cases).
Verified: 3 fail on old code, all 6 pass on new.

### F2 — Auto-turn re-armed at turn end (P0)

**File:** `backend-py/app/routers/workbench.py`

A live turn drains its queue at two loop boundaries (`workbench.py:3793`, `:4472`)
with no kind filter — so the existing early-return is *correct* for most cases.
The real race is a completion arriving **after the last drain** while the wake has
already given up. Added `_rearmAutoTurnIfPending()` in the turn task's `finally`,
which peeks non-destructively and re-arms only for `subagent`/`daemon` kinds — an
auto-turn must never consume a user's own queued message.

**Tests:** `tests/test_auto_turn_rearm.py` (7 cases).

### F3 — Auto-turn cap no longer silent (P1)

The runaway guard (4 consecutive auto-turns) stays — it's correct — but it now
emits `session.updated` with `action='auto_turn_cap_reached'`.

> **Design note worth keeping:** my first attempt invented a `chat.warning` event.
> Grepping the frontend bridge showed it handles only a fixed set
> (`session.*`, `chat.active/idle`, `invalidate`, `ui.customization`, `keepalive`)
> and drops everything else. Emitting an unhandled name would have *reproduced the
> exact bug I was fixing*. Always verify an event name has a frontend `case`.

### F4 — Unbounded prompt growth + cross-session tool leak (P1)

**File:** `backend-py/app/services/tools/model_tools.py`

`assembleToolDefs` appended its per-session short-catalog hint onto the
module-global `_BRIDGEToolDefs['tool_search']` description **in place**, twice per
turn. Measured: **97 → 897 → 1697 → 2497 → 4097 chars**, growing forever.

Three consequences, all confirmed empirically:
- one session's tool names leak into **every other session's** prompt;
- provider prefix cache is permanently broken for a core tool;
- the inflated token estimate trips the budget, which silently **drops
  auto-loaded skills** and trims preloaded tools to 3 — it self-amplifies.

Now patches a per-call copy. Verified: global stays pristine, the hint still
reaches the model, and output is byte-identical turn over turn.

**Tests:** `tests/test_model_tools_bridge_isolation.py` (5 cases).

### Validation

```
ruff    — clean on all 5 changed/added files
mypy    — clean on all 3 changed source files
pytest  — 388 passed, 0 failed  (subagent/orchestrator/workbench/queue/tool-def selection)
```

---

## 2. The single biggest remaining gap: subagent output has no chat render path

**This is why it fails "especially in the UI."** The backend defect (F1) was real,
but even with it fixed the answer still has nowhere to appear in the transcript:

- `AssistantBlockTimeline.tsx:620-695` hands only `{status, task}` to
  `SubagentDelegateRow.tsx:38-45`, which draws a **one-line chip**.
- The answer text lives only in the right drawer, whose replay filter
  (`RightDrawerSubagentsSection.tsx:144-152`) **never matches** the persisted
  `subagent*` event names.
- `subagentBlocks` is never persisted, but the SSE cursor **is** (localStorage).
  After a reload, session switch, ring eviction, or the subscriber-detach gap, a
  late `subagentDone` hits `if (!current) return {}` and is dropped — permanently,
  because `lastSeq` has moved on.

So there are three independent loss points: the backend discard (fixed), the
missing render path, and the non-persisted blocks.

**Recommendation (P0, next):** render subagent output inline in the transcript as
a collapsible block, persist those blocks, and either replay from the DB or
re-baseline the cursor. oh-my-pi and deepseek both solve the reconnect half with a
**process epoch on sequence numbers** so a client can detect a restart instead of
silently getting an empty replay (`hermes tui_gateway/event_replay.py:25-27`,
`deepseek` reconnect-safe fold returning a `rebaseline` action).

---

## 3. Ranked improvements

Ordered by (impact × confidence) ÷ effort. **Shipped** = done this session.

### P0 — do next

| # | Item | Source | Effort | Risk |
|---|---|---|---|---|
| 1 | **Render subagent output in the chat transcript**; persist the blocks; fix the non-persisted-blocks + moved-cursor drop | audit | M | Med |
| 2 | **Synthetic tool-result pairing on every exit path** with an `__synthetic` / `executed:false` marker — a missing `tool_result` is a hard 400 from strict providers, and August's protection is scattered across branches that can disagree | oh-my-pi P0-1 | M | Low |
| 3 | **Replay-safety veto on retry** — refuse to retry a turn that already emitted visible text or executed tools. August's 8-family taxonomy is string-shaped and has no replay-safety concept; a retry after a partial commit duplicates what the model already said and did | oh-my-pi P0-5 | M | Med |
| 4 | **`coerceToolResult` choke point** — normalize *every* tool result before it enters history. August has salvage for tool *arguments* and nothing for *results*; a bare string or wrong-shaped dict is persisted verbatim = provider 400 + permanent transcript corruption. Empty body + `is_error:true` is a real Anthropic failure mode | oh-my-pi P0-2 | S | Low |
| 5 | **Settings crashes kill the app** — the settings outlet renders *outside* the `ErrorBoundary` (`ChatLayout.tsx:602-605` vs `:610`); every other top-level route gets a `SectionBoundary` | UI audit | S | Low |
| 6 | **Realtime bridge dies silently** — unguarded async IIFE at `bridge.ts:261-263`; if `whenReady()` rejects, `started` stays true with `es === null` and `scheduleReconnect` is never reached. No session status or invalidation for the rest of the session | UI audit | S | Low |

### P1

| # | Item | Source | Effort | Risk |
|---|---|---|---|---|
| 7 | **Container sandbox runs with Docker defaults** — no `--cap-drop`, `no-new-privileges`, `--user`, or `--pids-limit`, despite being the only tier that truly enforces `network:false`. Five flags | backend audit | S | Med |
| 8 | **Durability barrier blocks the event loop** — synchronous full-transcript DELETE+re-INSERT called from the async loop 3× per round, on the loop that also serves SSE, under an uncapped round count | backend audit | M | Med |
| 9 | **Quit hard-kills the backend**, so every lifespan teardown is dead code — `taskkill /F` means `flush_pending_saves`, `flush_thread_pending`, `event_log.flush` never run. The `turn_outcomes` ledger under-reports every quit. No `/api/shutdown`, no `CTRL_BREAK` | lifecycle | M | Med |
| 10 | **Adopted orphan poisons the stamp** — force-kill leaves an orphan on 8085; next launch sees health, calls a no-op `killStoredChild`, adopts the old process, then writes the *new* stamp. New UI, old backend, permanently | lifecycle | M | Med |
| 11 | **Output-cap fitting against the context window** — lower `max_tokens` to remaining room so a large-cap model stops on `length` instead of 400-ing. August's `token_budget.py` has no notion of the output cap; side turns (BTW, recap) have no overflow recovery at all | oh-my-pi P0-6 | S–M | Low |
| 12 | **⌘N skips all New-chat guards** — `App.tsx:64` calls `createSession(null)` directly, bypassing the streaming/draft confirm | UI audit | S | Low |
| 13 | **Idle SSE subscriber permanently loses `warning`/`info`** — `session-subscriber.ts:102-117` advances `lastSeq` past them; handlers only `console.*` | UI audit | S | Low |
| 14 | **`allow_scope_override` never moves scope** — the UPSERT omits `scope`, so consolidation "moves" overwrite a global row's value while it stays global. The one real memory-loss path found | backend audit | S | Med |
| 15 | **Add a floor to the runaway guard** — uncapped rounds + disabled-by-default `costCeiling` leaves a model reading a *different* file each round unbounded in both rounds and dollars; novelty and the polling guard both miss it | backend audit | S | Low |

### P2 (selected)

- **`useless` result flag → in-place elision.** Zero-hit `search_files`, a `wait`
  that returned nothing new — real context tax that August's token-count pruner
  can't see. The tools that know already produce the signal. (oh-my-pi P0-3)
- **Two-clock timeout model** — separate header wait from per-read idle,
  re-armed on every chunk. A single global timeout kills long generations
  mid-stream. (MiniMax P0-1)
- **Spec-complete SSE parser with explicit trailing-event flush** — the final
  token fragment is exactly what naive parsers drop, and it's what produces
  empty/truncated turns. (MiniMax P0-2)
- **Attribute retry/fallback spend to the model that billed it** — Opus retries
  before a DeepSeek fallback are currently billed at the DeepSeek rate in the
  composer chip, usage page, *and* spend ceiling. (backend audit #6)
- **Every unhandled rejection toasts "Unexpected error"** — `main.tsx:29-32` with
  no `AbortError` filter. (UI audit)
- **Bound the usage endpoint's per-event cost loop** — it fetches *all*
  `usage_events` rows while the events list 20 lines up is capped at 500.
- **28 of 47 settings sections have no rail row** (`WorkspaceShell.tsx:200`), and
  `docs/settings-audit.md` is materially stale (38→47 sections, dead
  `RAIL_CHILDREN`).

---

## 4. Where August is already ahead — do not regress

Worth stating plainly, because three of the four reference repos lack these
entirely and a future contributor could "helpfully" remove them:

- **Memory.** BM25 + FTS, the always-in `profile` lane, the model-managed CRUD set
  (`remember`/`list_facts`/`forget` in both `AUGUST_CORE_TOOLS` and
  `_BARE_TOOL_ALLOW`), the write door with its denylist, and staged restore that
  keeps `.pre-restore`. deepseek-harness has **no long-term memory at all**.
- **Learning.** episode mining, skill distillation, supersession lineage, the
  recurrence meter, the curator router — a real self-improvement loop that
  oh-my-pi and deepseek do not have.
- **Sandbox & permissions.** two independent axes, fail-closed everywhere,
  read-before-edit as a real gate, chained-command handling that
  `ls && rm -rf /` cannot classify as `read`. MiniMax has **no sandbox at all**.
- **Pricing correctness.** `cost_estimator.price_for_model` is genuinely the only
  pricing source, `0.0` is treated as a price and never as an absence, and a
  half-set price is honestly labelled `estimated=True`.
- **Shutdown ordering and the migration runner** are genuinely solid — which is
  precisely what F9 is about: the Tauri side kills the process before any of it
  gets to run.

---

## 5. Traps — do not copy

Each reference repo has failure modes worth naming, several of which *look* like
the bug you're chasing:

- **MiniMax's REPL silently drops `tool_use` blocks** and prints
  `[empty response]`. Their error normaliser is substring-based, and `/save` is a
  non-atomic write. The repo is a platform-API client, **not** an agent harness —
  no tool dispatch, subagents, memory, or learning loop.
- **oh-my-pi's** `agent-session.ts` is 11,674 lines — do not adopt that shape. Its
  sandbox liveness check is `pid`-only, which would misbehave on August's primary
  **Windows** platform. `snapcompact` and the KDL rule-tree migration are traps.
- **hermes-agent's** `IterationBudget` docstring is stale (claims 500/50; the code
  is `sys.maxsize`/250) — a live example of why these reports cite code, not docs.
- **Windows-specific:** transient `EPERM` on atomic rename, and junction traversal
  in recursive delete. Both bite in the `%APPDATA%` config paths.

---

## 6. Suggested sequence

1. **Subagent render path** (P0 #1) — completes the fix you asked about; the
   backend half is already done.
2. **Tool-result integrity** (P0 #2, #4) — synthetic pairing + `coerceToolResult`.
   Together these close the class of "output vanished" bugs at the protocol level.
3. **Replay-safety veto** (P0 #3) — the highest-value correctness idea found.
4. **Resilience batch** (P0 #5, #6 + P1 #12, #13) — small, independent, each
   closes a silent-failure path.
5. **Lifecycle & durability** (P1 #7–#10) — graceful shutdown first, since it
   currently makes a large part of the backend's own careful teardown unreachable.

Each step is independently shippable and independently testable.
