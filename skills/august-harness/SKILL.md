---
name: august-harness
description: "How the August agent loop works: session modes, turn lifecycle, update_state phases, plan mode. Load before any multi-step work."
category: harness
version: 1.0.0
platforms: [linux, macos, windows]
---

# August Harness — How the Loop Works

August is a desktop agent harness. You talk to the user through native tool
calls; the harness runs them in a sandboxed session and streams results back.
This skill explains the loop itself so you work *with* it instead of against it.

## What this skill is

A reference for the August agent loop — session modes, the turn lifecycle, the
`update_state` phase machine, plan mode, and the self-heal rules the harness
applies to your output. It is the first skill to load before any multi-step
work in August.

## When to Use

- Before any multi-step change: file edits, refactors, debugging, multi-tool
  investigations, or anything that needs `update_state` progress tracking.
- When you are unsure whether to switch modes (chat / agent / code /
  orchestrator) or how `enter_plan_mode` / `submit_plan` interact.
- When a turn misbehaves (validation errors, narration, stuck phases) — the
  self-heal rules explain how the harness reacts and what to do next.

## Prerequisites

- A running August desktop session (or the workbench backend on
  `:8085` + a web/desktop client).
- Access to the `harness_introspect` and `harness_propose` tools, which are
  how you inspect this surface and file improvement proposals.
- Nothing user-side to install; the loop runs in the existing session.

## How to Run

1. Load this skill (`load_skill "august-harness"`) at the start of a session
   so the loop contract is in your context.
2. Pick a session mode with `set_agent_mode(chat|agent|code|orchestrator)`.
3. For multi-step work, call `update_state(phase, step)` at start / progress
   / finish; advance the phase or step every turn or risk a hard stop.
4. Use `enter_plan_mode` for non-trivial changes, write the plan to
   `.aug/plans/<sessionId>.md`, then `submit_plan` for approval.
5. File improvements with `harness_propose(...)`; a human approves before any
   change is applied.

## Session modes

A session runs in one mode; switch with `set_agent_mode`:

- `chat` — text only, no tools. For casual conversation.
- `agent` — native tool calling (default). Use for real work.
- `code` — one fenced ```python block executed through the sandbox with a
  workspace-bound API (`read_file`, `write_file`, `run_command`, `list_files`).
- `orchestrator` — dispatch workstreams; no direct shell/edit.

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
- End real work with `phase='complete'`. `run_command` always surfaces the
  exit code (zero included), so report real receipts, not claims.

Tool rounds are budgeted. Batch independent calls in parallel, prefer the
`bulk` family for repeats, and stop gathering once you have enough to act.

## Plan mode

For non-trivial changes (multiple files, architecture choices, risky or
destructive ops) call `enter_plan_mode`, investigate with read-only tools,
write the plan as markdown to the session plan file it returns
(`.aug/plans/<sessionId>.md` — the only writable file in plan mode), then call
`submit_plan`. For simple, clearly-scoped requests, skip plan mode and just do
the work.

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
  Emit the real call; a narration with no actual tool call triggers a
  self-heal retry of the turn.
- Tool results are truncated to your capability profile — page with
  `read_file` offset/limit instead of re-reading everything.

## Pitfalls

- Spinning on the same `update_state(phase, step)` across many rounds trips
  the reflection nudge and a hard stop — advance the state or finish.
- Treating `run_command` as a black box. The exit code IS the receipt;
  report it (zero included) instead of narrating "I ran X."
- Filing a `harness_propose` and assuming it applied. Proposals wait on a
  human reviewer in Settings → Insights → Harness Improvements.

## Verification

- `harness_introspect()` shows your current tool surface, skill catalogue,
  turn-loop flow map, and open proposals — re-run it after a config change.
- The end of a real task is `update_state(phase='complete')`, not silence.
- For long sessions, call `summarize_session` before any compaction so the
  handoff summary survives the cut.
