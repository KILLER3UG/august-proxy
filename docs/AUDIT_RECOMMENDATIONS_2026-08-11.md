# August Proxy — Full-Repo Audit & Recommendations

**Date:** 2026-08-11
**Method:** 6 parallel deep-audit agents (backend logic, frontend UI/UX, harness internals, subagent lifecycle, prompts, external research) + targeted external research on OpenHands, SWE-agent, Codex, Claude Code.
**Scope:** `backend-py/app/`, `frontend/desktop/src/`, harness prompts, docs.
**Fix status (same day):** all P0 items + most of P1 shipped and green — backend `ruff`/`mypy` clean, 1434 pytest passing (57.8% cov); frontend `tsc` clean, 738 vitest passing. See §8 for the implemented checklist. Second pass (same day): spawn-tool consolidation + A5/A6/A7/P6/P8 + reminder fixes, all green.
**Verdict:** The base architecture is sound (see §7 "verified-correct"), but there are **1 critical proxy bug, 1 security bypass, ~10 high-impact logic bugs, and a subagent path that is genuinely not usable end-to-end**. The harness's self-improvement machinery (routing, capability profiles, self-heal) exists but several loops are **one-way ratchets or measure the wrong thing** — fixing those is what makes every model better.

---

## TL;DR — Top 10 actions

| # | Action | Why | Sev |
|---|--------|-----|-----|
| 1 | Fix proxy casing bug — `resolveManagedOpenaiToolCalls` reads `tool_calls` after `snakeToCamel` made it `toolCalls` | Non-streaming `/v1/chat/completions` managed-tool calls silently dropped; client gets an empty response | 🔴 C |
| 2 | Route code-mode `run_command` through `check_hardline_command`/sandbox | Code mode can `cat` API keys in Full Access — breaks the documented hardline guarantee | 🔴 H |
| 3 | Fix subagent recursion: block BOTH `spawn_subagent`+`spawn_subagents`, real runtime depth counter | Unbounded recursion + semaphore slot deadlock (10-min hangs) | 🔴 C |
| 4 | Wire `emit`/session into HTTP subagent spawns + forward text deltas | User-launched subagents are invisible in chat ("not usable") | 🔴 H |
| 5 | Fix routing win definition: exclude `refusal`/`thinking_only`/`tool_error` from wins (like `drift_report`) | autoRoute currently routes **toward** refusing models | 🟠 H |
| 6 | Port stream-rule + stall detection + model-scaled compaction into the subagent loop | Subagents silently self-destruct instead of self-correcting | 🟠 H |
| 7 | Make capability auto-detect two-way (suggest upgrades too) + auto-apply with revert | Harness actively tunes every model's tool surface | 🟠 H |
| 8 | Kill the no-op `SubagentApprovalInline` stub; mount the 4 dead subagent components inline | One honest approval surface; visible subagent lifecycle | 🟠 H |
| 9 | Fix "exit code" cluster: M1 verifier regex, M2 false-positive error flags, M3 truthy `exit_code` | Success is being flagged as error on several paths | 🟠 H |
| 10 | Declare `fileHash` in tool schemas + centralize self-heal strings + fix `yieldSchema` failure status | Weak models bypass hash protection; prompts contradict | 🟡 M |

---

## 1. Subagent launching — bugs + better UI (your priority)

### 1.1 How the lifecycle works today

Two spawn paths:
- **Model-initiated (works):** parent calls `spawn_subagent`/`spawn_subagents` tool → `SubagentOrchestrator.spawn` (`services/subagent_orchestrator.py:179`) → `_runWithSlot` → `runSubagent` → `executeSubAgent` (`services/workbench/subagent.py:74`). `_emit` → `event_log` → SSE → `applySubagentEvent` → `subagentBlocks` → renders in chat.
- **User-initiated (broken):** `POST /api/subagents/spawn` (`routers/subagent.py:75`) → same executor with a `SimpleNamespace` shell session and **no `emit`**. Only reachable from Brain → Runs modal and the Board page.

### 1.2 The bugs (why it's "not usable")

**🔴 C1 — Unbounded recursion + semaphore deadlock.** `subagent.py:239,420` filter only the *singular* `spawn_subagent` tool; the plural `spawn_subagents` (`tool_registrations/agent_tools.py:398-437`) is NOT excluded, so subagents can spawn subagents. The depth guard reads the *agent definition's* `depth` field (hardcoded `0` for synthetic agents, never incremented at runtime), so `_MAXAgentDepth=4` never trips. Each subagent holds an orchestrator semaphore slot (`MAX_CONCURRENT_WORKERS=5`) for its whole run; 5 parents each spawning children → `SLOT_ACQUIRE_TIMEOUT_SECONDS=600` (10-min) hangs.
*Fix:* block `{'spawn_subagent','spawn_subagents'}` in both filters; thread a real runtime depth counter (`child = parent+1`) and check `>= _MAXAgentDepth` on it.

**🔴 C2 — HTTP-launched subagents never stream and bind to the wrong session.** `routers/subagent.py:92-94` calls the executor with no `emit`; `_getSession` defaults `id='default'` because the launcher sends no `X-Session-Id`. So user-launched agents emit zero SSE, never populate `subagentBlocks`, never appear in the right-drawer roster (filtered by `workbenchSessionId`), and are only visible in the DB-backed Brain → Runs list. Launching from the UI looks dead.
*Fix:* pass `workbenchSessionId` from the launcher; route the HTTP path through the same `event_log` emitting path as the model tool.

**🟠 H1 — `yieldSchema` failure returns `status: 'completed'`.** `subagent.py:489-516`: on JSON/`validateToolArguments` failure the result text is overwritten but falls through to `updateJob(...,'completed')` and returns `{'status':'completed'}`. `_result_is_failure` treats non-empty text as success → failed yields tally as wins, and the parent gets an error string where it expected JSON.
*Fix:* track `yield_failed`, return `{'status':'failed','error':'yield schema validation failed','result':...}`.

**🟠 H2 — All the good knobs are unreachable from any UI.** `yieldSchema`, `effort`, `model`, `restrictedTools`, `context` are dropped in `routers/subagent.py:30-38,81-91` and missing from the frontend `WorkItem` (`api/subagents.ts:6-13`). The only launcher (RunsTab) exposes goal + agentId + mode. `yieldSchema` is only reachable when the *model* invents it.
*Fix:* extend the router `WorkItem` + `api/subagents.ts` + launcher editors (see 1.3).

**🟠 H3 — Background completion watcher is fire-and-forget; one thrown `emit` kills all later completions.** `spawn_subagents_tool.py:475-494`: `asyncio.create_task(_watch())` untracked; per-iteration `emit` not individually guarded — a closed parent SSE stream throws, the watch task ends, and `_enqueue_completion` (the line after emit) never runs for any subsequent subagent. Parent spawned N, hears back from one.
*Fix:* best-effort `emit` contract; keep `_enqueue_completion` independent of SSE liveness; track the task for `close()`.

**🟠 H4 — No live token streaming from subagents.** `_subEmit` (`subagent.py:264-275`) forwards only `finalOutput`; the workbench caller never emits `textDelta`. A 2-minute subagent shows tool calls, then the final blob — looks hung. (Also the root-cause gap for the UI: nothing to append.)
*Fix:* forward provider SSE `textDelta`s as `subagentText` append events; `apply-subagent-event.ts` already appends text blocks.

**🟠 H5 — The only user launch surface is a bare modal buried in Brain → Runs.** One textarea ("one goal per line"), free-text agentId, no model/effort/yieldSchema/restrictedTools/budget/templates/streaming/cancel. No launch entry in the chat composer or right drawer. This is the "not usable".
*Fix:* see the panel proposal in 1.3.

**🟡 M1 — Compaction errors silently swallowed** (`subagent.py:309-316`, `try/except Exception: pass`) → unlogged context overflow later.
**🟡 M2 — Shell-session attr mismatch:** `_getSession` builds `agentId` (camel), `executeSubAgent` reads `session.agent_id` → `parentId` always `''` on HTTP path → `deriveChildPermissions` never runs for user-launched agents.
**🟡 M3 — Tool-only runs masked as "completed with no textual answer"** — parent can't tell a 12-tool-call real run from a no-op. Synthesize a real summary or structured `{actions, artifacts}`.
**🟡 M4 — `restrictedTools` documented 3 different ways** (denylist in `spawn_subagents_tool.py:73-77`, allowlist in `subagent_worker.py:49-51`, denylist implemented at `subagent.py:235-237`). Standardize: denylist.
**🟡 M5 — RunsTab sends no session → agents attributed to `'default'`** even after C2's emit fix.
**🔵 L1–L3:** AGENTS.md overstates retry-policy inheritance (both read global config — not a bug, but docs lie); `agent_registry.executeSubAgent` is a deprecated fail-stub; DB telemetry writes are fire-and-forget.

### 1.3 Proposed UI — "Spawn subagents" composer panel

**Entry points:** `/spawn` slash-command in the composer; a "Spawn subagent" toolbar button; `+ New spawn` in the right-drawer subagents section. Panel opens inline above the composer (~520px).

```
┌─ Spawn subagents ──────────────────────── [–] [×] ─┐
│ Mode: (•) auto  ( ) proposed   [▶ Advanced]        │
│ Parallelism cap: 5  │ Depth cap: 4  (read-only)    │
│ ───────────────────────────────────────────────────│
│ ▼ Work items (3)                          [+ Add]   │
│ ┌─ #1 ──────────────────────────── agent: explore ▾┐
│ │ Goal:  [Find all callers of executeSubAgent     ]│
│ │ Model: (inherit ▾)  Effort: medium ▾  Rounds≤ 25 │
│ │ [▶ yieldSchema] [▶ context] [▶ restrict tools]   │
│ │   [✕]                                            │
│ └───────────────────────────────────────────────────┘
│ ┌─ #2 ──────────────────────────── agent: general ▾┐
│ │ Goal:  [Summarize the retry policy across calls ]│
│ │ Model: gpt-4o-mini ▾  Effort: low ▾  Rounds≤ 10  │
│ │ [▼ yieldSchema]  ┌ JSON schema ───────────────┐  │
│ │                  │ { "type":"object",          │  │
│ │                  │   "required":["summary"], … }│  │
│ │                  └────────────────────────────┘  │
│ │ [▶ context] [▶ restrict tools]   [✕]             │
│ └───────────────────────────────────────────────────┘
│ ───────────────────────────────────────────────────│
│ Templates: [Research codebase ▾]  [Save current as]│
│ Cost/round budget (shared): maxTurns 25  ☐ inherit │
│ parent retry policy                                 │
│            [Cancel]   [▶ Launch 3 subagents]        │
└─────────────────────────────────────────────────────┘
```

- Per-row: **Goal** (required) · **agent** dropdown (registry + synthetic `general/explore/plan/shell`) · **model** picker (default inherit → `getModelForRole`/smol routing) · **effort** low/med/high/max · **yieldSchema** collapsible JSON editor with live validation · **context** textarea · **restrict tools** chip picker (denylist) · **Rounds≤** per-item `maxWorkbenchToolLoops` override.
- **Launch behavior:** `POST /api/subagents/spawn` accepts `workbenchSessionId` and wires `emit` to that session's `event_log` → subagents stream `subagentStart/Text/ToolCall/ToolResult/Done` into the *active chat* using the existing `SubagentLaunchList`/`SubagentTimeline` — no new renderer needed.
- **Live progress + cancel:** hover `×` per row → `POST /api/subagents/{taskId}/terminate` (endpoint exists, `api/subagents.ts:55`); per-row elapsed timer exists (`SubagentExpandedCard.tsx:80-86`).
- **Result preview:** with `yieldSchema` → parsed JSON in a fenced block; on H1 failure → red `[yield validation failed]` banner + "Re-run this subagent".
- **Dead code to revive:** `SubagentLaunchList` (Cursor-style checked list), `SubagentExpandedCard`, `SubagentDetailModal`, `SubagentRow` are built, zero importers — wire them into `AssistantBlockTimeline` (which currently *skips* subagent blocks at `:398-410`).
- **Delete:** `SubagentApprovalInline` (no-op stub — Approve/Cancel fire toasts and do nothing; `MessageBubble.tsx:205-214`).

**Minimal path to "usable" (≈1 day):** C1 guard (10 lines) + C2/M5 emit+session wiring + H4 delta forwarding + revive `SubagentLaunchList` inline + kill the stub. The panel (1.3) is the full UX.

---

## 2. Critical & high-severity bugs (fix-first)

### 2.1 Proxy adapter layer (external clients — Claude Code, Cline, Codex hit these)

- **🔴 C1 (agent1) — `resolveManagedOpenaiToolCalls` casing bug.** `adapters/openai.py:282-288`: body is `snakeToCamel`'d (`tool_calls`→`toolCalls`), then line 288 reads `message.get('tool_calls')` → `None` → loop exits before executing ANY managed tool; client receives empty response with tool calls silently dropped. **Zero test references.** Same bug class as the 0.12.21 fix. *Fix:* read `toolCalls`, or read `rawBody` like the `usage` path already does. Add regression test.
- **🟠 H1 — streaming OpenAI→Anthropic appends bare `tool_result` blocks with no `role`.** `adapters/anthropic.py:957,960`: `currentMessages.append(tr.model_dump())` (no role) vs native path's `_toolResultBlockMessage(tr)` (`:876,879`). Next round `translateMessages` reads `msg.get('role','')` → `''` matches nothing → tool result **silently skipped** → stale tool re-invoked forever.
- **🟠 H3 — `message_stop` emitted between managed-tool rounds.** `anthropic.py:836` + `stream_state.py:493`: upstream's `message_stop` (or synthesized stop) is yielded to the client mid-loop; Anthropic SDK clients finalize on `message_stop` and drop round-2 events. `sawTerminalStop` only suppresses the final synthesized stop. *Fix:* suppress terminal events for intermediate rounds; emit only on the final `not toolUses` round.
- **🟠 H4 — streaming `/v1/chat/completions` managed loop only does one extra round.** `openai.py:373-469`: round-2 tool calls are appended to `currentMessages` but never executed — no outer `while True` (the non-streaming path has one). Stream ends with pending tool calls.
- **🟠 H5 — malformed JSON swallowed to `{}` on three OpenAI→Anthropic paths.** `stream_state.py:69-71` (`to_anthropic_tool_use`), `anthropic.py:545`, `:988` — vs the native path's `{'_raw': raw}` fix. The workbench self-heal check (`toolInput.get('_invalid_json') or toolInput.get('_raw')`, workbench.py:2851) is bypassed on these paths.
- **🟡 M5 — `_translateToResponsesFormat` casing bug** (`routers/proxy.py:525`): reads `tool_calls` from a `snakeToCamel`'d body → tool calls lost when a non-compliant gateway returns `choices` from `/responses`. Read `toolCalls or tool_calls`.
- **🟡 M4 — Anthropic-upstream error path discards the error body** (`openai.py:894-895` returns only status; every other path uses `normalize_upstream_error`).
- **🔵 L2 — `strict: null` always emitted in tool defs** (`proxy_tool_defs.py:216`) — strict gateways may reject.
- **🔵 L3 — OpenAI-upstream usage reported 0/0** in `resolveManagedAnthropicToolUses` (snake keys; branch currently dead).

### 2.2 Security

- **🔴 H2 — code mode bypasses the hardline credential protection.** `code_runner.py:70-77`: the preamble's `run_command` calls `subprocess.run(..., shell=True)` directly — never `check_hardline_command` or the sandbox backend. The model's Python can `run_command("cat $(find / -name providers.json)")` in **Full Access**. `read_file`'s `_bind` checks workspace containment but not `check_hardline_path`. The docstring claims "same permission policy… as any shell command" — false. *Fix:* route through `run_sandboxed`/tool dispatch, or at minimum `check_hardline_command(cmd)` + hardline checks in `_bind`.
- **🟡 M7 — PRE/POST tool-hook exceptions swallowed with `except Exception: pass`** (`workbench.py:4090,4114`). A security hook (e.g., secret_guard) that itself raises is silently bypassed — the tool proceeds. *Fix:* fail-closed on PRE-hook exception for security hooks; log WARNING at minimum.
- **🟡 M6 — hash-anchored-edit guard matches read tools via substrings** (`workbench.py:4027-4042`): `read_creations` matches `'create'`, `find_and_replace` matches `'replace'`, `remove_field` matches `'remove'` → read-style tools trigger the hash check. Use token boundaries or an explicit mutating set.

### 2.3 "Exit code" cluster — success flagged as error (all stem from the 0.14.0 "always surface exit code" change)

- **🟡 M1 — verifier verdict regex matches the FIRST `exit code:` occurrence** (`system_tools.py:191`, also `workbench.py:3600`). A test runner printing "exit code: 1" before the sandbox's appended "Exit code: 0" flips the verdict. Use `findall` and take the last, or anchor to the sandbox marker.
- **🟡 M2 — `isOpenaiToolResultError` flags "exit code" as error** (`openai.py:180-181`, also `selfheal.py:14`): now that success prints "Exit code: 0", every successful command matches → managed tools re-executed, error hints appended to successes. Use `exit code: [1-9]` or a non-zero regex.
- **🟡 M3 — proxy `format_managed_tool_result` uses truthy `if result.get('exit_code')`** (`proxy_tools.py:340`) → `exit_code: 0` omitted, violating the documented "always surface exit code". Use `is not None` (the workbench path `policy.py:144` already does).

### 2.4 Workbench / verifier / routing

- **🟠 A1 — routing counts refusals/thinking-only/tool-error turns as WINS.** `workbench.py:3700` records `ok = turnError is None`; `routing_evidence.py:134-141` (`get_suggestions`) and `:225-230` (`best_by_task`) use `SUM(ok)` ignoring the correctly-recorded `outcome` column. Only `drift_report` (`:275`) filters. With `AUGUST_AUTO_ROUTE=1` the harness routes **toward** refusing models. *Fix:* use the outcome-filtered win expression + `verified` bonus.
- **🟡 A7 — verifier gate strands the answer with no recovery.** `workbench.py:3579-3623`: if `verifierEnforced` and the model streams a final answer without `update_state`/`verificationCommand`, `vcmd` is empty → auto-run skipped → no steer → amber banner + withheld answer forever. *Fix:* enqueue a steer, or auto-infer a command from the task type.
- **🟡 L4 — verifier auto-run is one-shot**; ignored steers strand the answer forever. Bounded retry or auto-release-with-warning.
- **🔵 A13/A14 — golden evals are OpenAI-only and don't cover the Anthropic `_raw` path, stream-rule aborts, or the hard-stop**; stall thresholds don't scale to remaining budget.

---

## 3. Harness — making every model BETTER when deployed in August

The scaffolding (capability profiles, routing evidence, self-heal, verifier, compaction, stream rules, golden evals) is all there. The highest-leverage work closes loops that are **one-way, desynchronized, or measuring the wrong thing**.

### P0 — Fix the routing win definition (also A1, §2.4)
`get_suggestions`/`best_by_task` must exclude `refusal`/`thinking_only`/`tool_error` from wins and prefer verified turns (`-winRate, verified_rate desc, avgTokens asc`). One ~20-line change turns "routing learns" from a claim into reality. **This is the single highest-leverage harness change.**

### P1 — Close the capability loop: two-way, auto-applied experiment (A5)
Today the fingerprint only ever *suggests downgrades* (`trace_store.py:223-235`); a downgraded model that improves never gets its surface back, and suggestions are manual. Make it: (1) suggest upgrades when rates improve; (2) auto-apply the suggested profile for the next session (store under `profile-suggested:{model}` with `applied_at`); (3) track before/after win rate and auto-revert. New `profile_experiments` table. The harness then actively tunes every model's tool surface — weak models shrink, strong models grow, automatically.

### P2 — Port parent-loop self-correction into subagents (A2+A3+A4)
`subagent.py:412` (`if not toolUses: break`) ignores `stream_rule` entirely — a subagent that narrates a tool call just ends. No stall detection. Compaction threshold hardcoded at 110k tokens — wrong for the 32k/64k "smol" models subagents default to. Extract `_match_stream_rule` handling + stall detector into shared helpers; use `_resolveModelContextWindow` for compaction. Subagents then converge instead of flailing.

### P3 — Reversible self-heal downgrade within a turn (A6)
`workbench.py:3448-3452` downgrades to bare surface after `parseFailures >= 3` and never restores it. A model with one burst of 3 malformed calls loses `web_search`/`browser` for the whole turn. Restore full surface after N consecutive clean rounds.

### P4 — Landmark-preserving compaction
`context_compressor.py:152` = head(4)+tail(6)+middle-summary; `localSummarize` is crude text truncation that can drop the only mention of a file path or error string. Add pin-predicates: original user goal, latest `update_state` transition, latest failing test receipt, discovered file paths. Also: tool-result elision at 120 chars can drop the actual error (prompts audit §27) — raise to ~300 chars or keep lines matching `error|fail|pass`. Consider OpenHands-style manual trigger on context-window errors + event-count trigger alongside tokens.

### P5 — Expand golden evals into a model-improvement regression suite (A13)
(1) Anthropic `ScriptedClient` variant covering `_raw` malformed path + Anthropic stream-rule aggregation; (2) a "weak model" script emitting malformed JSON 40% → assert downgrade → recovery → completion (the P3 regression); (3) a late-stall scenario asserting the hard-stop; (4) **feed eval failures into `capability_fingerprint`** so eval → profile → real turns → eval becomes a real self-improvement loop.

### P6 — Add exploration to routing (A11)
Epsilon-greedy (or: skip autoRoute when the configured model has < N samples for this task type). Today a hovering incumbent starves alternatives forever — a new/better model is never tried, so it can never accumulate evidence.

### P7 — Prompt-cache stability across self-heal downgrades
The downgrade swaps the `tools` array, invalidating Anthropic's tool cache breakpoint mid-turn for the model that's already struggling. Keep `_BARE_TOOL_ALLOW` tools as a stable *prefix* of the full list so a downgrade extends the cached prefix instead of replacing it; document the invariant.

### P8 — Verifier gate recovery steer (A7)
Turn the stonewall into a recoverable nudge (see §2.4).

### P9 — Stream-rule patterns: multilingual + shape-anchored (A8)
`providers.py:511-528`: `narrated_tool_call` is English-first-person only ("I'll use…") and **false-positives on legitimate preamble** from strong models that narrate *then* emit the call — the abort discards the real tool call. `code_fence_tool_call` matches any fenced JSON with a `name` first key, clashing with prompts that legitimately want fenced JSON (background review, text-tool protocol, code mode). *Fix:* defer the narration check to end-of-turn (fire only if no native tool_use in the same turn); require tool-call *shape* (`name` + `arguments`/`input`); add non-English narration phrases.

### Verified-correct (do NOT regress — from the audit)
- Capability profiles ARE applied to both `toolDefinitions` (workbench.py:1109) and `openaiToolDefinitions` (:1244); the self-heal downgrade re-fetches both. No wire desync.
- Malformed-JSON handling IS symmetric: Anthropic `_raw` (stream_state.py:284) + OpenAI `_invalid_json` both feed the workbench self-heal check. The "never execute as `{}`" guarantee holds on the native paths (but not the proxy paths — H5).
- `verifierEnforced` withholding fires even when the model never calls `update_state`.
- `/v1/responses` pass-through is a clean native-SSE forward, correct for "client's own tools".
- Round cap + retry/fallback/promotion chain correctly records `turnError` as routing losses.
- Base workbench persona (`AUGUST_PLATFORM`, context_builder.py:26-36) is genuinely model-agnostic — "you are the underlying model; August is the platform" avoids persona-collision. Keep it.

---

## 4. Prompts — findings & fixes

| # | Prompt | Issue | Fix |
|---|--------|-------|-----|
| P1 | Base persona | Honorifics + unicode-math rules burn budget for no reason | Drop them; keep identity + skills/tools distinction |
| P2 | Tier-1 rule 2 (memories) | Auto-memory "not instructions" vs added-memory "honor it" is a subtle 2-class distinction weak models blur | Make the contrast explicit with distinct tags |
| P3 | Verifier gate body | Promises markers "PASSED"/"0 failed" but the verdict logic accepts a broader set — prompt and logic misaligned | Reword to "exits 0 / no failures" or narrow the logic |
| P4 | Code-mode prompt | Tells the model "assign result variable" — **runner never reads it** (prompt lies); "single block" but only the LAST fenced block runs | Implement `result` capture or drop the sentence; state the last-block + stdout-only contract |
| P5 | Self-heal "Do NOT stop" | Wrong instruction for a model already failing to emit JSON; bare-surface downgrade is silent | "Retry once; if you can't, stop tools and answer in text"; explain the downgrade; centralize the string (2 copies today, already drifting) |
| P6 | Stall nudge | Fires ~round 20 (12+8), hard-stop 2 rounds later — a weak model burns ~20 rounds first; one-shot nudge; asks a failing model to call ANOTHER tool | Lower threshold (~5-6); allow 2 differently-framed nudges; if `parseFailures>0`, tell it to stop tools and summarize |
| P7 | Stream reminder | Detection patterns English-only + false-positive on preamble (see P9 in §3) | End-of-turn check; shape-anchored patterns |
| P8 | Verifier reviewer (`AUGUST_VERIFIER_REVIEWER`) | Judges "satisfy the goal" with only goal+answer text — **no verification receipts, no code, no test output**; PASS/FAIL parser brittle (`startswith('FAIL')` — "It does not FAIL." passes) | Pass command + actual output into the prompt; require first-token PASS/FAIL, re-prompt once; add a rubric |
| P9 | Refusal reminder | First reminder offers "answer in text" as an option — lets a refusing model dodge the escalation ladder | First reminder should demand a tool call |
| P10 | Subagent system prompt | Tells it "do not spawn further sub-agents" but the capabilities block still ADVERTISES `spawn_subagent`/`spawn_subagents` prose | Pass `include_agents=False`/trimmed `<agents>` block |
| P11 | yieldSchema | Tool-only runs produce the synthesized "(completed with no textual answer)" string — **not valid JSON** → schema runs always "fail" | Synthesize `{"status":"completed","summary":...}` or require a final JSON object |
| P12 | SUBAGENT_COMPLETE | Delivered as a bare user message with no system-prompt explanation — weak parents treat it as a new instruction | Add one explainer line in Tier 1 / `<agents>` |
| P13 | Background review | "No code fences" while every parser strips fences — harness is internally inconsistent about fenced JSON (stream rule aborts the same behavior!) | Pick one posture; relax to match parsers |
| P14 | `AUGUST_REMINDER` (proxy) | **Anthropic proxy path only** (OpenAI path gets nothing); claims "you have access to the August tool suite" — factually wrong (tools = client's own); `should_inject` keys on literal "August" substring | Make it honest ("use only tools provided in this request"); inject symmetrically on both paths; fix the substring key |
| P15 | `RULE_REMINDER_MESSAGE` | Imported, never injected (dead code); would conflict with full-access mode if wired | Delete or make mode-conditional |
| P16 | `fileHash` contract | Undocumented in any schema — weak models never send it, so hash protection silently doesn't apply to them | Add to `write_file`/`edit_file`/`str_replace` schemas + read-tool description |
| P17 | Jargon | "Verifier Reflex" in `update_state` description | Say "verifier gate" |
| P18 | Tool descriptions | `enter_plan_mode`, `set_agent_mode`, guardrails are genuinely good | Keep as the house style |
| P19 | Thinking-only finalOutput | Detects "max_tokens exhausted by thinking" but pushes the fix onto the user | Auto-retry once at lower effort before surfacing |
| P20 | Compaction summary | Injected as user-role with no framing; weak models respond to it as a new instruction; 120-char tool caps drop errors | Frame it in Tier 1 ("treat as history, not a new request"); raise tool cap |

---

## 5. UI/UX — findings & fixes

### Bugs
- **Nonfunctional File/Edit/View/Help menu bar** (`ChatLayout.tsx:478-483`) — plain spans, no handlers; a known issue that survived the redesign passes. Wire or remove.
- **`RightDrawer.renderSection` has no `default`** and single-section path skips the card wrapper (`RightDrawer.tsx:199-204,237-283`).
- **`ContextBar` dead branch for `read_only` evidence** (`ContextBar.tsx:47-56`) — renders nothing.
- **Capability-profile fields untyped** — `toolSurface`/`maxTools`/`maxToolResultChars` read via `as`-casts in `ModelRow.tsx:55-88` on the AGENTS.md-flagged high-risk sync surface. **Type them in `api/providers.ts` first.**
- **`ProviderDetailForm` apiFormat mutates on change with no rollback** on error (`:188-198`) — dropdown lies after a failed save.
- **`AddProviderForm` has no Test-connection before save**; **`AddModelForm` omits the wire-format select** that multi-format gateways (Zen) need at creation.

### Polish
- Empty state is bare (`ChatEmptyState.tsx`) — no "no model configured → AI Setup" callout, no example chips, no clipboard affordance.
- Streaming status is thin: `WorkingIndicator` unused; no "reading X / running Y" pill in the chat surface (data already exists in `makeStreamHandlers.ts`).
- Verifier shield toggle is an unlabeled icon (`ComposerToolbar.tsx:262-285`) — the whole feature is invisible until found. Label it or fold into the agent-mode menu.
- "Full access" default mode is described as "fewer confirmations" — doesn't say it skips both gates. Reword; consider defaulting new sessions to `ask`.
- `ChatTitlebar` overflow menu has ONE item ("Read aloud"). Add Fork/Export/Copy session/Clear/Theme or remove.
- ContextRing tooltip is hardcoded hex — broken in light theme. Use CSS vars.
- "Result cap (KB)" label vs char field unit mismatch (`ModelRow.tsx:261-272`); tool-surface options unexplained; `max` effort missing from the Max-effort dropdown though the composer offers it; `fmtTime`/`formatTime` assume different units in Reliability vs RunsTab.
- Two error surfaces (inline block vs toast) offer different actions (Retry/Switch-model vs Retry/Provider settings) — unify.
- Virtualized vs non-virtualized chat paths render at different widths; `+80` magic pad for footer.
- Legacy `ChatComposer` duplicates `ModelEffortMenu` — delete or re-export.

### Observability
- Cache hit rate is hover-only; no persistent amber "cache: 12%" signal + one-click Compact (machinery exists: `CompactionNoticeCard`).
- Routing suggestion is a transient toast; stamp the assistant message with `routed: {from} → {to} · {winRate}` (data arrives via `routingSuggestion` SSE).
- Reliability dashboard is rich but buried at `/settings/reliability` — link it from chat error blocks and model-test failures.

### New features (nice-to-haves, all low-risk)
1. **"Probe capabilities" on a model row** — auto-detect tool support/reasoning/context window, one-click "Apply suggestions" (pairs with P1).
2. **Per-session spend ceiling** with warn/pause.
3. **"N files changed · M commands run" digest card** on turn completion with one-click Open diff.
4. **Compare action on any assistant message** (re-run on 1-2 alt models, inline diff — fork machinery exists).
5. **Evals drill-down** — click an eval run → scenario trace (data exists via `GET /api/brain/harness/evals/{taskId}`).
6. **History browse** — `/history` route; data already in localStorage + transcript API.
7. **Notes scratchpad** surfaced from title bar, promotable to long-term memory.

---

## 6. External inspiration — mapped to August

Research targets: OpenHands (docs.openhands.dev, fetched), SWE-agent (paper/known design), OpenAI Codex CLI + cloud (docs/known), Claude Code (known), Cline/Aider (known), plus the harnesses you named (Hermes, Pi, "Oh My Pi", Prime Agent — no stable public architecture docs found in a time-boxed search; treated as inspiration names only). All mappings are concrete-to-concrete.

| Idea | Source | August mapping |
|------|--------|----------------|
| **Stuck Detector: 5 patterns with thresholds** — repeated action-observation 4+, action-error 3+, monologue 3+, **alternating ping-pong 6+**, context-window errors; *semantic* comparison ignoring IDs/timestamps; auto-halt | OpenHands (docs.openhands.dev/sdk/guides/agent-stuck-detector.md) | August has only "no phase/step movement" stall detection (A4) + a contiguous-only duplicate guardrail. Add alternating-cycle detection and semantic comparison — directly fixes the `read_file(a)/read_file(b)` loop hole |
| **Security analyzer: risk levels LOW/MEDIUM/HIGH/UNKNOWN, UNKNOWN confirms by default, LLM analyzer on a SEPARATE model, reject-with-feedback** | OpenHands (sdk/guides/security.md) | Map onto hardline/guard-mode: classify actions (pattern + LLM ensemble), fail-closed on UNKNOWN, and when rejecting, return feedback so the model can pivot (August's verifier rejections already do this well — extend to mutations) |
| **Condenser: event-count trigger (120 events, keep 4 head, compress to 60), manual trigger after context-window errors, `forgotten_event_ids` metadata, pipeline condensers** | OpenHands (sdk/arch/condenser.md) | August compacts by tokens only, auto-only. Add: manual compaction trigger on context-window error, event-count trigger, pin predicates (P4) |
| **Task tool: synchronous blocking subagents, `TaskObservation{task_id, subagent, status, text}`, resumption by task_id, structured output via exact-format Skill instructions** | OpenHands (sdk/guides/task-tool-set.md) | August is *ahead* here: async parallel spawn + `yieldSchema` JSON validation. Adopt: **resume-by-task-id** (continue a failed subagent) and the honest `status: completed|error` contract (fixes H1) |
| **History truncation keep-first/keep-last with the middle summarized; minimal tool interface (ACI); observations returned as plain text with timeouts** | SWE-agent (paper; swe-agent.com) | August's head(4)+tail(6) is the same shape — add the landmark pins so the middle doesn't lose the thread (P4); keep the workbench tool surface minimal |
| **`model_abilities` per-model feature gating; approval modes; sandbox tiers (read-only / workspace-write / full)** | Codex CLI | August's capability profiles + modes are the same idea — complete the loop with auto-apply/auto-revert (P1) and surface sandbox tier in the UI |
| **Skills (reusable prompt bundles) + slash commands + hook lifecycle with `allow_managed_hooks_only`** | Codex CLI / Claude Code | August has a `skills/` dir + hooks already; add hook-managed-only mode (trusted hooks cannot be shadowed) and fail-closed hook semantics (M7) |
| **Compaction with explicit "this is a summary, not a new request" framing** | Claude Code | Prompts P20 |
| **Subagents: parent passes brief + tool subset; result returned as structured block; depth limits** | Claude Code | August already does this — complete the missing loop pieces (A2-A4) |
| **Epsilon-greedy exploration in routing decisions** | Bandit literature (Codex routing, standard) | P6 |
| **Reject-with-feedback loops everywhere** | OpenHands, Claude Code | August's verifier messages already model this — apply the same shape to mutations + subagent spawn rejections |
| **Verifier: evidence-based review (receipts passed to the reviewer)** | (Audit-driven) | P8 — reviewer must see command output + code, not just the answer text |

On the harnesses you named directly: **Hermes** (Nous) — the relevant pattern is disciplined tool-call formatting & refusal recovery in its agent training; **Pi** (Inflection) — the conversational persona design, applicable to August's *chat mode* persona (warm, terse, no tool-call narration); **"Oh My Pi"** — no distinct public architecture; treat as a persona-flavored Pi variant; **Prime Agent** — likely PrimeIntellect's agentic stack; its notable pattern is predictable structured YAML-ish action schemas for tool use, similar to SWE-agent's ACI minimalism. I did not find stable public architecture docs for these four within the time budget — the OpenHands/Codex/SWE-agent mappings above are the grounded, higher-value imports.

---

## 7. Prioritized roadmap

**✅ = implemented & green on 2026-08-11** (full suite: 1434 pytest + 738 vitest)

### P0 — Fix now (correctness/security; each ≤ 1 day)
1. ✅ Proxy casing bug C1 + regression tests (§2.1) — `openai.py:288`, caller `:592-611`, `M5 routers/proxy.py:525`
2. ✅ Code-mode hardline bypass H2 (§2.2) — `code_runner.py` embedded guard rendered from live `hardline.py` patterns + parity test `tests/test_code_runner_hardline.py`
3. ✅ Subagent recursion guard C1 + runtime depth counter (§1.2) — `subagent.py` `SUBAGENT_BLOCKED_TOOLS` + `depth` threaded through worker/orchestrator
4. ✅ HTTP subagent emit/session wiring C2+M5 (§1.2) — router `_makeEmit` → event_log, `X-Session-Id` from RunsTab/BoardPage, `agent_id` shell attr, `yieldSchema` in WorkItem
5. ✅ Routing win definition A1/P0 (§3) — `routing_evidence.py` outcome-filtered wins + verified-rate tiebreak
6. ✅ Exit-code cluster M1+M2+M3 (§2.3) — verifier last-match regex, `exit code: [1-9]` patterns, `is not None` check
7. ✅ Kill no-op approval stub; mount dead subagent components inline (§1.3) — `SubagentApprovalInline.tsx` deleted; `SubagentLaunchList` renders in `AssistantBlockTimeline`

### P1 — This iteration (harness correctness; each ≤ 2-3 days)
8. ✅ Subagent self-correction parity A2+A3+A4 (§3 P2) — stream-rule handling, model-scaled compaction (`_resolveModelContextWindow * 0.55`), stall detection + hard-stop
9. ✅ `yieldSchema` failure status H1 + JSON salvage A10 (§1.2) — `status: 'failed'` on yield failure; `salvage_json_object` first
10. ✅ Stream-rule pattern fixes A8/P9 + fenced-JSON posture decision (§4) — subagent loop now handles narration; AUGUST_REMINDER made honest + brand-keyed; RULE_REMINDER_MESSAGE deleted; multilingual/shape-anchored patterns still open
11. ✅ Verifier reviewer with receipts + robust PASS/FAIL parser (§4 P8) — reviewer now sees the verification command receipts; first-token PASS/FAIL parser with one strict re-prompt
12. ✅ Tool-hook fail-closed M7; `fileHash` in schemas (§2.2, §4 P16) — PRE hooks deny on exception (WARNING logged), POST logs; `fileHash` documented in read_file/write_file schemas + `**_extra` on `_writeFile`
13. ✅ Tool-result delta streaming for subagents H4 (§1.2) — verified ALREADY WORKING: providers emit per-delta `finalOutput` → `_subEmit` → `subagentText` → frontend appends (audit false positive)
14. ✅ In-turn downgrade reversibility A6/P3 (§3) — full surface restored after 3 clean rounds on the bare set
15. ✅ Capability auto-detect two-way + auto-apply experiment A5/P1 (§3) — upgrade suggestions added when a downgraded model recovers (auto-apply/revert still open)

### Also shipped (second pass)
- **Spawn-tool consolidation:** `spawn_subagent` (singular) removed — one tool (`spawn_subagents`) covers single + batch + blocking (`background: false`); schema gained per-item `effort`/`model`/`yieldSchema`. All 7 referencing modules + 5 test files updated.
- **P6 routing exploration:** epsilon-greedy — an under-sampled configured model runs ~50% of the time so alternatives can accumulate evidence.
- **A7 verifier recovery steer:** when enforcement is on and the model ends without declaring a verification command, a steer enqueues instead of stranding the answer.
- **Test infra:** fixed a pre-existing registry leak in `test_tool_policy_parity` (module fixture registered integration tools and never unregistered — flaked `test_workbench_tool_definitions` in cross-file batches).

### P2 batch (third pass, all green)
- **P9 stream-rule patterns:** fenced detection is now shape-anchored (`name` + `arguments`/`input` — a config payload `{"name": …}` no longer aborts); narration detection is **deferred to end-of-turn and cancelled when a real tool call arrives** (strong models narrate THEN emit — the old mid-stream abort discarded the genuine call); multilingual narration phrases (FR/ES/DE) added.
- **Stuck-detector expansion (OpenHands):** `ToolCallTracker` now detects **alternating ping-pong cycles** (warn at 8 / block at 10 trailing alternations) — the identical-call detector only caught contiguous repeats (`read_file(a)/read_file(b)` loops slipped through).
- **P7 + L5 in one change:** bare-essential tools now sort FIRST in both wire-format tool builders — a self-heal downgrade yields a *prefix* of the full list (Anthropic prompt-cache breakpoint stays valid), and `maxTools` truncation cuts non-essential tools first instead of by registry position.
- **P4 landmark compaction:** `compressMessages` gained `pin_predicates` — `update_state` transitions and failing verification receipts survive the middle summary verbatim (capped at 4); wired in the parent loop and subagent loop.
- **P5 eval expansion:** `ScriptedClient` gained an Anthropic `messages_stream` (covers the `_raw` malformed-input aggregation path — previously OpenAI-only); `run_turn` gained `wire_format='anthropic'`; 4 new golden scenarios (Anthropic malformed self-heal, Anthropic tool round-trip, **downgrade→restore reversibility**, **late-stall hard-stop**); `record_eval_run` now feeds real-model outcomes into `session_traces` so capability fingerprints react to eval failures — the eval→profile→turns→eval loop.
- **Spawn panel UX (lean v1):** "Spawn sub-agents" entry in the composer `+` menu opens a modal (goal lines, agent role, effort) bound to the active session — launched agents stream into the current transcript.

### Batch 4 (fourth pass, all green)
- **A5 auto-apply + auto-revert (capstone):** with `AUGUST_AUTO_PROFILE=1`, capability-profile suggestions are written into the provider store automatically and opened as an experiment (before-rates recorded); once the model accumulates 8+ new traces, the fingerprint is re-evaluated — regressed rates → revert to the previous surface, held/improved → confirmed. The harness now tunes each model's tool surface *and undoes changes that backfire*.
- **L4 bounded verifier retries:** the auto-run is no longer one-shot — a second ignored steer force-releases the withheld answer next turn with a warning (no more permanently stranded answers).
- **A12 race-free decision log:** auto-route decisions moved from a memory read-modify-write (racing under concurrency) to a SQLite `routing_decisions` table.
- **Frontend polish:** the inert File/View/Help chrome is now functional (New chat / Toggle sidebar / Shortcuts); ContextRing tooltip + tone scale use design tokens (was hardcoded hex — broken in light theme); verifier shield toggle always shows a "Verify" label (was an unlabeled icon).
- **Evals drill-down:** eval run rows in the Reliability dashboard open a detail modal (model, rounds, duration, failure notes) — the per-scenario trace is inspectable.

### Batch 5 (fifth pass, all green)
- **Per-session spend ceiling:** `session.costCeiling` (USD, 0=off) enforced in the turn loop BEFORE any model call — a blocked turn emits a clear error until the user raises the ceiling or starts a new chat. Cost estimated from cumulative tokens with env-tunable rates (`AUGUST_PRICE_IN_PER_M`/`AUGUST_PRICE_OUT_PER_M`, cache-hit input billed at 10%). API `POST /api/workbench/cost-ceiling`; composer extras gained a `CostCeilingChip` (live `$cost / $ceiling`, amber ≥80%, click-to-set).
- **Probe capabilities:** `GET /api/providers/{id}/models/{model}/probe` runs connectivity + tool-support + instruction-following probes and returns a suggested `toolSurface`; the ModelRow gained a probe button with an "Apply <surface> surface" one-click action — weak models get detected, not guessed.
- **Subagent resume-by-task-id (OpenHands pattern):** `POST /api/subagents/{taskId}/resume` re-dispatches a finished/failed run with the same goal + agent, bound to the ORIGINAL session (events stream into the same transcript); RunsTab rows gained a ↻ Resume button.

### Batch 6 (sixth pass, all green — remaining nice-to-haves)
- **Compare action on assistant messages:** a ⤺ Compare button on every assistant message opens the Arena launcher pre-filled with the user prompt that produced it — pick 2–3 models and run them side by side (full reuse of the existing Arena split-pane machinery, no new renderer).
- **History browse route (`/history`):** a searchable, day-grouped conversation list (title / last message / model), click-to-open, per-row delete, New chat entry — sidebar nav item included.
- **Notes → memory promotion:** the right-drawer notepad gained a "Promote to memory" action that saves the note under a searchable `note:` KV key — `memory_search` finds it in any future session.

### Batch 7 (seventh pass — remaining small correctness + prompt consolidation)
- **M4:** the OpenAI→Anthropic upstream error path now preserves the upstream error body (`normalize_upstream_error`) instead of a bare status code.
- **L2:** `anthropic_to_openai_tool_definition` omits `strict` unless a real value exists — no more `"strict": null` for strict gateways.
- **L3:** OpenAI-upstream usage keys (`prompt_tokens`/`completion_tokens`) normalized to Anthropic keys in `resolveManagedAnthropicToolUses`.
- **M8:** `OpenaiToAnthropicStreamState` normalizes a `None` tool-call index to 0 (parity with `OpenaiStreamAccumulator`) — providers that omit `index` no longer fragment one tool call across deltas.
- **A9:** `capability_fingerprint` filters traces by provider — two gateways serving the same model id are no longer merged.
- **Prompt consolidation:** the `[Validation Error]` self-heal message is ONE canonical function (`validator.validationErrorText`) used by the workbench loop, the subagent loop, and both proxy adapters (four copies were drifting); the `<agents>` capabilities block now advertises only the consolidated `spawn_subagents` tool and explains `[SUBAGENT_COMPLETE]` receipts; the verifier-lesson heuristic uses stable rule text (per-turn blocker detail removed) so repeats merge instead of fragmenting into N near-duplicates.

### Batch 8 (eighth pass)
- **Code-mode `result` capture:** the code-mode prompt's "assign your final answer to a variable named `result`" contract is now HONORED — the runner surfaces the assigned value (`[result] …`) alongside stdout; regression tests cover both the captured and the no-`result` paths.
- **Per-model pricing table:** new `cost_estimator` module (model-prefix $/1M table: Claude/GPT/o1/DeepSeek/Gemini/Llama/Qwen/Mistral/Grok + env overrides, cache-hit input at 10%) — used by BOTH the spend-ceiling gate and `get_usage.totalCost`, so the composer chip, the ceiling, and the Usage page finally agree (the chip previously showed $0.000 because cost was never computed).
- **Spawn modal v2:** an "Advanced" section (shared context, restricted-tools denylist chips, `yieldSchema` JSON editor with invalid-JSON hint) — every backend knob the spawn tool supports is now reachable from the composer launcher.
- **Verifier steer with inferred command:** when enforcement is on and the model never declares a verification command, the steer now suggests one inferred from the task type (`pytest -q` for tests/bugfix/refactor, `compileall` for docs) — suggested, never auto-run.

### P2 — Next iteration (model improvement loops; 1-2 weeks)
16. Golden-eval expansion + eval→profile feedback P5 (§3) — open
17. Routing exploration P6; verifier recovery steer A7/P8 — open
18. Landmark-preserving compaction P4 + manual trigger (§3) — open
19. Prompt-cache prefix stability P7; proxy-path prompt-cache symmetry — open
20. Spawn panel full UX (§1.3); probe-capabilities button; spend ceiling (§5) — open
21. Stuck-detector pattern expansion (OpenHands mapping, §6) — open
22. AUGUST_REMINDER honesty + symmetry; delete RULE_REMINDER_MESSAGE (§4 P14/P15) — open

### What NOT to touch
Verified-correct surfaces in §3 — especially capability profile dual-wire application, symmetric malformed-JSON handling, and the base persona.

---

## Appendix — Finding IDs cross-reference

- `C1(agent1)` = proxy casing · `H1-H5(agent1)` = proxy/security · `M1-M8(agent1)` = medium cluster
- `C1(agent4)` = subagent recursion · `C2(agent4)` = HTTP emit · `H1-H5(agent4)` = yield/knobs/watcher/streaming/launcher
- `A1-A14(agent3)` = harness bugs · `P0-P9(agent3)` = harness roadmap
- `P1-P20(agent5)` = prompt findings · `§4/§5` = subagent UI + frontend findings
