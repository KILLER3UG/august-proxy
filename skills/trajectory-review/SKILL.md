---
name: trajectory-review
description: "Review how an agent reached a result, not only whether it passed: tools called, detours, unverified assumptions and wasted rounds. Use when a task finishes or flips in an eval, a turn ends badly, or the user asks why the agent did something; do not use it for a final-answer-only code review."
category: engineering
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [trajectory, eval, turn-outcomes, debugging]
    related_skills: [independent-review]
---

# Trajectory Review

A passing result can hide a fragile process: an assumption that happened to
hold, a lucky retry, ten round trips where two would do. A failing result
usually has its cause several steps before the error. Review the path, not
only the endpoint.

## When to Use

- A task finished, failed, or flipped in an evaluation and you need the cause.
- A turn ended with a non-`finished` reason (`cap`, `stall-stop`, `budget`,
  `length`, `error`, `interrupted`).
- The user asks why the agent chose a tool, repeated work, or ignored a
  failure.
- You are about to change the harness and need a baseline trajectory.

## When NOT to Use

- You only need a code review of the final diff; use `independent-review`.
- You are reviewing aggregate pass rates without opening a single run; that is
  a scoreboard, not a trajectory review.
- The run was reconstructed from memory or a summary. Get the real record
  first.

## Prerequisites

Use the actual record:

- The session transcript: `GET /api/workbench/sessions/{id}/transcript`, or
  the chat's saved messages.
- The per-turn ledger: `turn_outcomes` (stop reason, rounds, malformed calls,
  surface downgrades, edit verifications, guardrail hits). NULL means
  unrecorded, not zero.
- The event stream: `turn_end`, `recovery`, `compaction`, `contextPressure`,
  subagent and daemon events.
- For a benchmark: `august-bench`'s `trajectory.json` plus its JSONL event
  stream. `--script` records every request body the loop built, so an
  assertion can be about what would have gone to the provider.
- The model, provider, settings and repo state used for the run.

## How to Run

1. Build a compact timeline. For each round: intent, tool and key arguments,
   result, next decision.
2. Mark the path as you walk it:
   - **Unverified assumption** — the agent acted on something it never checked.
   - **Detour** — repeated searches with changing keywords, re-reading one
     file, retries without a change in approach.
   - **Wrong tool or arguments** — including a tool the surface did not offer.
   - **Context waste** — a large output pulled in and never used; polling
     instead of waiting for a notification.
   - **Missed signal** — an error or failing receipt it saw and ignored.
   - **Instruction drift** — a constraint stated earlier and broken later,
     often after compaction.
3. Find the first step after which failure became likely, or the riskiest step
   in a pass.
4. Map each finding to the cheapest durable fix:
   - Unchecked assumption → a verification step in a skill or project rule.
   - Wrong tool → tool description, naming or grouping.
   - Lost constraint → a file the next turn reloads, or `write_scratchpad`.
   - Polling → background task with a completion notification.
   - Repeated per-turn overhead → context-injection review.
   - Model limitation → record it and re-check after the next model upgrade.
5. Confirm the fix with a repeated run, not a single sample.

## Quick Reference

| Signal | Where to look |
| --- | --- |
| Why did it stop? | `turn_end.reason`, `turn_outcomes.end_reason` |
| Did it repeat itself? | Receipt vocabulary, `(tool, target)` pairs |
| Did it recover? | `recovery` events, self-heal receipts |
| Was context the cause? | `contextPressure`, compaction events |
| Did a subagent change the path? | `subagent_*` events, the queue drain |
| Did it actually run the command? | Tool result exit code, not the model's prose |

## Output Format

```markdown
## Timeline
| # | Intent | Tool + key args | Result | Next decision |
|---|--------|-----------------|--------|---------------|

## Marked Steps
- Step N — <marker>: what happened, and why it matters.

## First Wrong / Riskiest Step
- Step N: the earliest point after which success became unlikely (or the
  step where a slightly different input would have broken a pass).

## Proposed Fixes
1. <fix> — addresses step N; verify by <repeated run or probe>.

## Evidence
- Record: <transcript / trajectory.json / turn_outcomes>
- Model, settings, repo state: <...>
- Runs compared: <N>
```

## Procedure

1. Do not accept the final answer as evidence of the process. Open the record.
2. Read the turn's stop reason before reading the code; "why did it stop" is
   usually answered there.
3. Walk the timeline in order. Do not jump to the error first; the cause is
   usually earlier.
4. Separate a defect in the model's choice from a defect in the harness. A
   tool that was never offered, a result that was truncated, or a notification
   that never arrived is a harness defect.
5. Check whether the agent saw the same evidence you are seeing. A result that
   was spilled, pruned or summarized may not have been in its context.
6. Turn one-off quirks into rules only when the same pattern has happened more
   than once or caused real damage.
7. Re-run the same task several times after a fix. Compare the trajectory, not
   just the score.

## Pitfalls

- Reconstructing the run from the final answer or from memory.
- Treating a higher average score as proof when a must-not-break task flipped.
- Blaming the model for a tool it could not see or a result it never received.
- Turning a single noisy run into a permanent prompt rule.
- Fixing the symptom (a retry, a longer timeout) without naming the step that
  caused it.

## Verification

- Every finding points to a step in the record, with the tool name and the
  result that supports it.
- A proposed harness fix has a before/after comparison over repeated runs, and
  the metric table includes requests, tokens, cache hits and wall time.
- A rejected finding is recorded with the reason, so the next review does not
  repeat it.

## Reference Files

None. The record itself is the reference; keep the timeline in the output.

---

Adapted from `stacks/ronny/skills/trajectory-review` in
[MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack) (MIT,
Copyright (c) 2026 MiniMax Code). The full notice is in `NOTICE.md` in this
skill directory.
