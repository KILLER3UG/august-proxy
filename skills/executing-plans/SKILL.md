---
name: executing-plans
description: "Execute written plans step-by-step with review checkpoints."
category: workflow
trigger: "when you have a written implementation plan"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Executing Plans

## Overview

Execute a written implementation plan step-by-step with review checkpoints. Each task is completed and verified before moving to the next.

**Core principle:** Follow the plan exactly. One step at a time. Verify each step before proceeding.

## When to Use

- You have a written implementation plan (from the `writing-plans` skill or user-provided)
- Subagent-driven execution is not available or not preferred
- Tasks are sequential or tightly coupled

## Workflow

### 1. Load and Review the Plan

Read the plan file completely. Before starting:
- Does each step make sense?
- Are file paths and commands correct?
- Any missing dependencies or context?
- Raise concerns with the user before starting

### 2. Execute Each Task

For each task in the plan:

1. **Start the task** — understand what needs to be done
2. **Follow the steps exactly** — implement as specified
3. **Run verification** — tests, linting, or whatever checks the task specifies
4. **If the task passes** — mark it complete, move to next
5. **If the task fails** — stop and investigate
   - Can you fix it within the task's scope? Fix it.
   - Is the plan wrong? Ask the user for clarification.
   - Is there a missing dependency? Note it and continue.

### 3. Handle Blockers

If you get stuck:
- **Missing context** — research or ask the user
- **Plan is unclear** — ask the user for clarification
- **Test won't pass** — investigate systematically (use `systematic-debugging` if needed)
- **Dependency missing** — note it and ask the user

### 4. Completion

When all tasks are complete:
- Run the full verification suite
- Load the `finishing-a-development-branch` skill via `august__load_skill` to guide the merge/PR/discard decision

## Red Flags

- **Skipping verification** — untested changes can't be trusted
- **Modifying the plan** — stick to what was approved. If changes are needed, discuss with the user first
- **Adding scope** — no "while I'm here" improvements during execution
- **Proceeding past a blocker** — unresolved issues compound. Fix first, continue second
