---
name: writing-plans
description: "Write comprehensive bite-sized implementation plans from approved specs."
category: workflow
trigger: "when you have a spec or requirements for a multi-step task"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Writing Plans

## Overview

Transform approved specifications into actionable implementation plans composed of small, independent tasks. Each task is sized for 2-5 minutes of focused work with exact file paths and test commands.

**Core principle:** A good plan makes implementation obvious. If a task needs more than 5 minutes, split it. If you cannot write a test command for a task, the task is not well-defined.

## When to Use

Use this skill when:
- You have an approved specification or requirements document
- A task involves changes to more than 2 files
- The work spans multiple logical steps
- You need to hand off work to a subagent
- Before starting any non-trivial implementation

**Do NOT use when:**
- The change is a single obvious fix (one file, one line)
- You are in the middle of debugging (use systematic-debugging instead)
- The requirements are not yet approved (use brainstorming first)

## The Process

### Phase 1: Scope Check

Before writing the plan, verify the scope is appropriate.

Read the spec and answer:
- How many files will change? (estimate)
- How many distinct logical steps?
- Are there dependencies between steps?
- Can it be done in one session?

**If the answer to any of these is "I do not know":**

```
august__run_command ls <relevant-directory>
```

Read the key files to understand current structure before planning.

**Scope guardrails:**

| Scope | Action |
|-------|--------|
| 1-3 small changes | No plan needed, proceed directly |
| 4-10 changes | Write a plan |
| 11+ changes | Split into multiple plans, ask user for priority |
| Spans multiple domains | Write separate plans per domain |
| Unclear requirements | Stop, ask user for clarification |

### Phase 2: Map File Structure

Identify every file that needs to be created, modified, or deleted.

For each file:
- **Absolute path** -- exact location in the project
- **Type** -- create / modify / delete
- **Purpose** -- one-line description of what changes
- **Dependencies** -- what must exist before this file can be worked on

Present this as a table:

```
| File | Type | Purpose | Depends On |
|------|------|---------|------------|
| /path/to/file.py | modify | Add X function | None |
| /path/to/new.py | create | Validation logic | file.py |
```

### Phase 3: Write Bite-Sized Tasks

Each task MUST have:

1. **Task ID** -- T1, T2, etc. (numbered in dependency order)
2. **Description** -- one clear sentence of what to do
3. **File paths** -- exact absolute paths involved
4. **Test command** -- exact command to verify the task works
5. **Dependencies** -- list of task IDs that must be completed first
6. **Estimated time** -- 2-5 minutes per task

**Task sizing rules:**

| If a task needs... | Then... |
|--------------------|---------|
| > 5 minutes to describe | Split it |
| > 5 minutes to implement | Split it |
| Changes to > 3 files | Split it |
| Knowledge of > 2 unrelated areas | Split it |
| A research first step | Make research a separate task |
| Multiple test commands | Split it |
| And then in the description | Split it |

**Task format example:**

```
### T3: Add rate limiting to the proxy handler

**Files:**
- C:\Dev\project\src\proxy\handler.py (modify)
- C:\Dev\project\src\proxyate_limiter.py (create)

**Actions:**
1. Create rate_limiter.py with a RateLimiter class that uses a token bucket algorithm
2. Import and initialize RateLimiter in handler.py
3. Call rate_limiter.check() before processing each request

**Test:**
pytest tests/test_rate_limiter.py -v

**Depends on:** T1 (handler interface defined), T2 (token bucket utility)

**Estimate:** 4 minutes
```

### Phase 4: Self-Review

Before presenting the plan, review it against these checks:

- [ ] Every task has an exact file path (no relevant files or etc.)
- [ ] Every task has a august__run_command test command
- [ ] Tasks are ordered by dependencies (no task requires something unlisted)
- [ ] No task exceeds the 5-minute estimate
- [ ] No task modifies more than 3 files
- [ ] All referenced directories and files exist (or are created in a prior task)
- [ ] The plan includes setup tasks (virtualenv, install deps, etc.) if needed
- [ ] The plan includes a final verify all task that runs the full test suite
- [ ] All file paths use the correct OS path separators
- [ ] Test commands use the correct test framework for the project

**If any check fails:** Fix the plan before presenting it.

### Phase 5: Offer Execution Choice

After presenting the plan, offer exactly these options:

```
1. Execute plan now -- dispatches each task in dependency order.
2. Save plan for later -- writes to a .plan.md file for future use.
3. Revise plan -- takes feedback and iterates.
4. Cancel -- discards the plan entirely.
```

For option 1, use august__spawn_subagent for each task:

```python
august__spawn_subagent(
    goal="Execute task T3: Add rate limiting to the proxy handler",
    context="""
    Task: T3
    Description: Add rate limiting to the proxy handler
    Files:
      - C:\Dev\project\src\proxy\handler.py (modify)
      - C:\Dev\project\src\proxyate_limiter.py (create)
    Actions:
      1. Create rate_limiter.py with a RateLimiter class
      2. Import and initialize in handler.py
      3. Call rate_limiter.check() before each request
    Verify: pytest tests/test_rate_limiter.py -v
    """,
    toolsets=["terminal", "file"]
)
```

**Dependency management:** Dispatch tasks in parallel only when they have no dependencies on each other. Use sequential dispatch for dependent tasks.

## Quick Reference

```
1. Scope Check    -- Is this plan-sized?
2. Map Files      -- Every file, every path, every purpose
3. Write Tasks    -- 2-5 min each, exact paths, test commands
4. Self-Review    -- Ten checks before showing the plan
5. Offer Choice   -- Execute / Save / Revise / Cancel
```

## Related Skills

When the plan is approved and ready for execution, load the subagent-driven-development skill via august__load_skill to dispatch tasks.

For very large plans (11+ tasks), consider whether the scope should be reduced first.
