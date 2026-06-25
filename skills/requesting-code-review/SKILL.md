---
name: requesting-code-review
description: "Dispatch a reviewer subagent with precise diff context via august__spawn_subagent."
trigger: "after completing each task, before merge"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Requesting Code Review

## Overview

Dispatch a code reviewer subagent with precisely crafted context — not the session's history — to catch issues before they compound.

**Core principle:** Review early and often. Fresh eyes catch what the implementer misses.

## When to Use

- After completing each task in subagent-driven implementation
- After completing a major feature
- Before merging to the main branch
- Optionally:
  - When stuck (a reviewer might spot what you missed)
  - Before refactoring (review the existing code first)
  - After fixing a complex bug (verify the fix is clean)

## Workflow

### 1. Prepare Context

Get the relevant git information:

```bash
# Current branch name
git branch --show-current

# Base SHA (where you branched from)
git merge-base HEAD main

# Head SHA (latest commit)
git rev-parse HEAD
```

### 2. Dispatch Reviewer

Use `august__spawn_subagent` with a structured context:

```
Goal: Code review for [description of changes]

Context:
- Description: [what was implemented]
- Plan/requirements: [what the spec required]
- Base SHA: [merge-base commit]
- Head SHA: [latest commit]

Check for:
- Correctness: Does the implementation match the requirements?
- Edge cases: Missing error handling or boundary conditions?
- Regressions: Could this break existing functionality?
- Security: Any injection, access, or data exposure issues?
- Style: Follows project conventions?
- Tests: Adequate coverage for the change?
```

### 3. Act on Feedback

When the reviewer responds:

| Priority | Action |
|----------|--------|
| **Critical** | Fix immediately before proceeding |
| **Important** | Fix before merging |
| **Minor** | Note for later, can defer |

If the reviewer identified issues:
1. Fix the issue
2. Run tests to verify
3. Optionally dispatch another review for the fix

If you disagree with the review:
- Re-read the feedback carefully
- Verify your position against the actual code
- If you're confident, explain your reasoning
- If you're unsure, ask for clarification

## Red Flags

- **Skipping review** — even small changes can have subtle issues
- **Vague context** — the reviewer needs clear requirements to evaluate against
- **Defensive responses** — the reviewer is helping. Engage with the feedback
- **Reviewing your own work** — self-review is necessary but not sufficient. Always get a second pair of eyes.
