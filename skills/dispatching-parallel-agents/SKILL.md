---
name: dispatching-parallel-agents
description: "Dispatch multiple independent subagents concurrently via august__run_team or august__spawn_subagent."
trigger: "3+ independent failures or tasks"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Dispatching Parallel Agents

## Overview

When you have multiple independent failures or tasks (different files, different subsystems, different bugs), dispatch dedicated subagents in parallel to solve each one concurrently. This saves time over sequential investigation.

**Core principle:** Independent problems get independent investigators. Parallel work finishes faster.

## When to Use

**Use when:**
- 3+ independent problem domains
- Failures in clearly different subsystems
- Tasks that don't share state or sequential dependencies

**Do NOT use when:**
- Failures are related / might share a root cause (investigate together first)
- Tasks touch the same files (would cause merge conflicts)
- Exploratory debugging (need to understand the problem before splitting)

## Workflow

### 1. Identify Independent Domains

Group failures or tasks by what is broken:
- Different test files? Different test suites? → Likely independent
- Same component? Same data flow? → Likely related, investigate together first
- One failure blocks another? → Fix the blocker first, then parallelize the rest

### 2. Create Focused Agent Tasks

For each independent domain, create a task with:
- **Scope:** Exactly what to investigate or implement
- **Goal:** Clear, testable outcome
- **Constraints:** Files or areas to stay within
- **Expected output:** Summary of findings or completed implementation

### 3. Dispatch in Parallel

Use `august__run_team` to dispatch multiple agents simultaneously, or `august__spawn_subagent` for individual tasks:

```
Task 1: Investigate test failure in module A → august__spawn_subagent
Task 2: Investigate test failure in module B → august__spawn_subagent
Task 3: Investigate bug in component C → august__spawn_subagent
```

### 4. Review Results

When agents return:
- Review each summary
- Check that fixes from different agents don't conflict
- Verify all changes are consistent

### 5. Verify

Run the full test suite to ensure no regressions across all changed areas.

## Red Flags

- **Starting parallel work without verifying independence** — related issues investigated separately miss the root cause
- **Tasks touch the same files** — will cause merge conflicts and wasted work
- **More than 5 parallel agents** — coordination overhead outweighs parallelism benefits
