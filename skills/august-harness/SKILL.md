---
name: august-harness
description: "How the August agent loop works: session modes, turn lifecycle, update_state phases, plan mode, verifier gate. Load before any multi-step work."
category: harness
version: 1.0.0
platforms: [linux, macos, windows]
---

# August Harness — How the Loop Works

August is a desktop agent harness. You talk to the user through native tool
calls; the harness runs them in a sandboxed session and streams results back.
This skill explains the loop itself so you work *with* it instead of against it.

## Session modes

A session runs in one mode; switch with `set_agent_mode`:

- `chat` — text only, no tools. For casual conversation.
- `agent` — native tool calling (default). Use for real work.
- `code` — one fenced ```python block executed through the sandbox with a
  workspace-bound API (`read_file`, `write_file`, `run_command`, `list_files`).
- `orchestrator` — dispatch workstreams; no direct shell/edit.
- `benchmark` — minimal 2-tool surface.

If a request is conversation, stay in `chat` behavior (just answer). If it is
work, use tools directly — do not narrate that you will use them.

## Turn lifecycle & update_state

Multi-step tasks must track state with `update_state`:

- Phases: `research | plan | implement | review | complete`.
- Call it when you **start**, **progress**, and **finish** a phase. The state is
  injected into the next turn so future-you knows where work left off.
- The loop watches progress: a turn whose phase/step never advances across many
  rounds gets a reflection nudge, then a hard stop. Advance state as you go;
  never spin on the same step.
- End real work with `phase='complete'` — this is also what satisfies the
  verifier gate when it is on.

Tool rounds are budgeted. Batch independent calls in parallel, prefer the
`bulk` family for repeats, and stop gathering once you have enough to act.

## Plan mode

For non-trivial changes (multiple files, architecture choices, risky or
destructive ops) call `enter_plan_mode`, investigate with read-only tools,
write the plan as markdown to the session plan file it returns
(`.aug/plans/<sessionId>.md` — the only writable file in plan mode), then call
`submit_plan`. For simple, clearly-scoped requests, skip plan mode and just do
the work.

## Verifier gate

Sessions may enable the verifier (session `verifierEnforced` flag). When on,
your final answer is withheld until `update_state(phase='complete')` passes
verification; a blocked verdict shows as a banner — fix the gap and complete
again, do not repeat the same final answer. `run_command` always surfaces the
exit code (zero included), so completion is judged on real receipts, not claims.

## Improving the harness itself

You can see your own machinery: call `harness_introspect` for tool-surface
health, skill stats, the turn-loop flow map, budgets, recent changes, and open
proposals. When you find something worth changing — an oversized description,
a misclassified tool, a config knob that would help — file it with
`harness_propose(problem, evidence, proposal, rollback, kind)`. Proposals are
reviewed by the user in Settings → Insights → Harness Improvements; nothing is
applied by you directly.

## Working memory inside a session

- `write_scratchpad` — one note that survives across turns (replaces previous).
  Use it for the current analysis/diff/next-step, not for logs.
- `summarize_session` — compact handoff summary; call before compaction on long
  runs.
- `update_state` notes persist too; prefer it for phase/step facts.

## Sub-agents, daemons, blackboard

- `spawn_subagents` for parallel independent research; they inherit your retry
  policy and can return structured results.
- `spawn_daemon` / `list_daemons` / `kill_daemon` for long-running background
  work; always kill daemons you no longer need.
- `write_blackboard` / `read_blackboard` / `clear_blackboard` share state
  between you and sub-agents; `list_workstreams` shows dispatched work.

## Self-heal rules

- A `[Validation Error] … Do NOT stop` result means your tool JSON was
  malformed — re-emit a correct call immediately.
- Never narrate a tool call ("I'll use the X tool", JSON in code fences).
  Emit the real call; narration aborts the stream and wastes a retry.
- Tool results are truncated to your capability profile — page with
  `read_file` offset/limit instead of re-reading everything.
