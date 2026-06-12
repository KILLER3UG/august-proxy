---
name: team-run-plan
description: Plan and coordinate an August multi-agent team run with scoped ownership, approvals, handoffs, and evidence-based completion
trigger: team run plan, project manager, coordinate agents, run_team, multi-agent plan, approve team work
---
Use this skill when the project manager coordinates a multi-agent `august__run_team` run or turns a broad request into scoped tasks for specialized agents.

## Inputs to extract

- overall goal
- required deliverables
- constraints and non-goals
- files or systems in scope
- agents that must run
- agents to exclude, especially `deployment` when no deploy is requested
- approval needs for edits, shell, memory, delegation, or deploy actions
- definition of done

## Planning workflow

1. Inspect the request and current repo state before delegating.
2. Split the work by ownership:
   - `project_manager`: plan, coordination, risk tracking, final synthesis
   - `frontend_dev`: React, Vite, Tailwind, UI state, browser behavior
   - `backend_dev`: Node services, routes, tools, providers, memory, Workbench backend
   - `qa_tester`: verification plan, tests, regression evidence
   - `documentation`: docs, README, user-facing notes
   - `deployment`: Docker, release, build, deploy, smoke checks
3. Prefer `august__run_team` over manually spawning agents one by one.
4. Use `exclude_team_roles: ["deployment"]` unless the task explicitly needs deploy/build/release work.
5. For each selected agent, write a focused task with:
   - exact scope
   - expected output
   - verification command or evidence required
   - handoff notes for other agents
6. Keep mutations behind the Workbench approval gate. If edits/shell/memory/deploy are needed, submit a plan and wait for approval before retrying.

## Delegation patterns

### Whole team except deployment

```json
{
  "goal": "implement and verify the requested change without deploying",
  "exclude_team_roles": ["deployment"],
  "task_by_agent": {
    "project_manager": "turn the request into a scoped implementation plan, route work, and synthesize results",
    "frontend_dev": "inspect and update UI files in scope, then report files changed and browser/test evidence",
    "backend_dev": "inspect and update backend files in scope, then report API/tool behavior and test evidence",
    "qa_tester": "create a verification plan, run relevant tests, and report pass/fail evidence",
    "documentation": "update docs or release notes if the change affects user behavior or setup"
  }
}
```

### Only backend and QA

```json
{
  "goal": "verify the backend change and fix regressions if approved",
  "team_roles": ["backend_dev", "qa_tester"],
  "parallel": true
}
```

## Handoff rules

- The project manager owns the final answer, but not all edits.
- Each specialist must report concrete evidence: file paths, commands, tests, logs, screenshots, or API results.
- QA should validate the final state after implementation, not only the proposed patch.
- Documentation should not invent behavior; it must match implemented behavior.
- Deployment must not run release/deploy commands unless the user explicitly approved deploy work.

## Completion checklist

- scope matches the user request
- all selected agents returned evidence
- risky actions were approved before execution
- tests or verification commands were run when possible
- docs were updated if user-facing behavior changed
- final synthesis includes:
  - what changed
  - evidence
  - risks
  - next steps
  - whether deployment was intentionally skipped
