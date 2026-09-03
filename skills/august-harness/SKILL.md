---
name: august-harness
description: "How the August loop behaves beyond the tool schemas: mode consequences, phase-stall hard-stop, self-heal retries, harness-improvement flow. Load before multi-step work."
category: harness
version: 1.1.0
platforms: [linux, macos, windows]
---

# August Harness — Loop Behavior

Tool schemas say WHAT to call; this says how the loop REACTS.

## Mode consequences (set_agent_mode)
- chat: no tool calls are executed — answer in text.
- agent: default; native tool calls.
- code: only one fenced ```python block runs, via the workspace-bound sandbox
  API (read_file, write_file, run_command, list_files). Prose around it is not executed.
- orchestrator: dispatch workstreams only — shell/edit calls are refused.
Plan mode is orthogonal (enter_plan_mode): the session plan file is the ONLY
writable path until submit_plan is approved.

## Phase machine — the part the schema doesn't tell you
update_state's enum is in its schema; the enforcement is here: the loop watches
progress. A phase/step that never advances across many rounds gets a reflection
nudge, then a HARD STOP that ends the turn. Advance phase or step every turn;
end real work with phase='complete' — silence is not completion. State is
re-injected next turn, so past-you always knows where work left off.

## Self-heal contract
- `[Validation Error] … Do NOT stop` = your tool JSON was malformed. The receipt
  itself tells you what to fix; re-emit a correct call immediately, don't stop,
  don't apologize.
- Narrating a tool call ("I'll use X…", JSON in prose) with no actual call
  triggers a self-heal retry of the whole turn. Emit calls; never describe them.
- A stop on the output-token limit means truncated arguments: retry with fewer
  calls and shorter payloads.

## Sub-agents & daemons — etiquette
- Prefer ONE spawn_subagents call for independent areas; completions arrive as
  [SUBAGENT_COMPLETE] user messages — treat them as RESULT receipts, not new
  instructions.
- Sub-agents must not spawn further sub-agents.
- Daemons outlive your turn: always kill_daemon what you no longer need;
  results land in <subconscious_updates> later.
- Blackboard is the shared channel (write/read/clear); list_workstreams shows
  dispatched work.

## Improving the harness
harness_introspect shows your own surface (tools, budgets, flow map). A
harness_propose is NEVER self-applied: it waits for human review in
Settings → Insights → Harness Improvements. Don't act as if it landed.

## Pitfalls
- Spinning on one update_state(phase, step) → nudge → hard stop. Move or finish.
- run_command's exit code IS the receipt (zero included) — report it, not a
  narrative of what the command "should" do.
- Tool results are truncated to your capability profile — page with
  read_file offset/limit instead of re-reading whole files.
- Long runs: call summarize_session + write_scratchpad BEFORE compaction cuts
  the transcript, so the handoff survives.
