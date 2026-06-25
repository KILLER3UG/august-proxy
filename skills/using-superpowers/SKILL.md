---
name: using-superpowers
description: "Entry-point meta-skill: find, invoke, and follow the right skill for any task."
category: meta
trigger: "starting any conversation"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Using Superpowers

## Overview

This meta-skill helps you find and invoke the right skill for any task. Before responding to a request, check if a skill exists that matches the task — and if so, load and follow it.

**Core principle:** If a skill exists for what you're about to do, use it. Skills encode proven workflows that produce better results than guessing.

## When to Use

At the START of every conversation or task:

1. Check if any available skill might apply (even 1% chance)
2. If yes → load it via `august__load_skill` and follow it
3. If no → respond normally

## Skill Selection Guide

### If the task is...

| Task type | Skill to load |
|-----------|---------------|
| Creative / design / unsure what to build | `brainstorming` |
| Bug / test failure / unexpected behavior | `systematic-debugging` |
| Writing code (feature or fix) | `test-driven-development` |
| Need an implementation plan | `writing-plans` |
| Execute a plan step by step | `executing-plans` or `subagent-driven-development` |
| Complete work / merge / PR | `finishing-a-development-branch` |
| Code review received | `receiving-code-review` |
| Code review needed | `requesting-code-review` |
| Receiving feedback | `receiving-code-review` |
| Need isolated workspace | `using-git-worktrees` |
| Create or edit a skill | `writing-skills` |
| Multiple independent tasks | `dispatching-parallel-agents` |

### Execution path

```
brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch
                                                                      ↓
                                                            requesting-code-review
                                                                      ↓
                                                            receiving-code-review
```

## How to Use a Skill

1. Call `august__load_skill { name: "skill-name" }`
2. The skill's instructions will be loaded into context
3. Follow the instructions exactly
4. If the skill references another skill, load that one when you reach that step

## Important Notes

- **User instructions override skill instructions** — if the user explicitly asks for something different, follow the user
- **Skills are tools, not straitjackets** — adapt the principles to your context
- **When in doubt, use the skill** — structured process beats improvisation for complex tasks
