---
name: finishing-a-development-branch
description: "Guide completion: verify tests, present merge/PR/keep/discard options, execute with cleanup."
category: workflow
trigger: "implementation complete, all tests pass"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Finishing a Development Branch

## Overview

When implementation is complete and all tests pass, this skill guides the structured decision of how to integrate the completed work. It prevents premature claims of completion, ensures clean workspace state, and executes the chosen option with proper cleanup.

**Core principle:** Do not declare work done without running verification, presenting clear options, and executing the chosen path with cleanup.

## When to Use

Use this skill when:
- All code changes for a feature/fix are implemented
- You believe tests pass and the work is complete
- A user says "done" or "ready to merge"
- Before creating a pull request
- Before switching to a new task

## The Process

### Phase 1: Verification Check

**STOP and verify before any completion claim.**

Run the full test suite fresh:

```
august__run_command pytest -q
```

Or project-specific test command:

```
august__run_command <test-command>
```

**If tests fail:**
- STOP immediately
- Report the failures to the user
- Load the systematic-debugging skill via august__load_skill
- Do NOT proceed to Phase 2

**If tests pass:**
- Record the test output as evidence
- Proceed to Phase 2

### Phase 2: Environment Detection

Determine the current git environment before presenting options.

Run:

```
august__run_command git rev-parse --abbrev-ref HEAD
```

Detect the environment type:

1. **Normal repository** -- standard main/master with a feature branch
2. **Git worktree** -- isolated worktree directory
3. **Detached HEAD** -- no active branch (checkout of a specific commit)

**Determine the base branch:**

```
august__run_command git symbolic-ref refs/remotes/origin/HEAD
august__run_command git remote show origin | grep HEAD branch
```

Default candidates: main, master, develop. If uncertain, report the detected branches and ask the user.

### Phase 3: Present Options

Present exactly four options to the user in this format:

---

**Work complete on branch <branch> (based on <base>).**

**Your options:**

1. **Merge to <base>** -- Fast-forward merge the branch into base, then delete the feature branch.
2. **Push and create PR** -- Push the branch to remote and open a pull request for review.
3. **Keep branch** -- Leave the branch as-is for later work. No cleanup.
4. **Discard branch** -- Delete the branch and lose all changes. **Requires typed confirmation.**

**Which option? (1/2/3/4)**

---

### Phase 4: Execute Chosen Option

#### Option 1: Merge to Base

```
august__run_command git checkout <base>
august__run_command git pull origin <base>
august__run_command git merge --ff-only <branch>
august__run_command git branch -d <branch>
```

**If merge conflicts occur:** STOP, report to user, do not force merge.

**Worktree cleanup (if applicable):** Remove the worktree directory.

```
august__run_command git worktree remove <worktree-path>
august__run_command rm -rf <worktree-path>
```

#### Option 2: Push and Create PR

```
august__run_command git push -u origin <branch>
august__run_command gh pr create --base <base> --fill
```

Report the PR URL to the user.

**Worktree cleanup:** Do NOT remove the worktree -- the branch is still active for potential changes.

#### Option 3: Keep Branch

- No git operations needed
- Report: "Branch <branch> preserved. It remains where it is."
- **Worktree:** Do NOT remove the worktree

#### Option 4: Discard Branch

**Requires confirmation.** Present:

```
WARNING: This will permanently delete all changes on <branch>.
Type the branch name exactly to confirm: <branch>
```

Wait for exact input. Then:

```
august__run_command git merge --abort 2>/dev/null; august__run_command git rebase --abort 2>/dev/null
august__run_command git checkout <base>
august__run_command git branch -D <branch>
august__run_command git push origin --delete <branch> 2>/dev/null
```

**Worktree cleanup (if applicable):**

```
august__run_command git worktree remove <worktree-path>
august__run_command rm -rf <worktree-path>
```

### Phase 5: Final Summary

Report what was done:

```
Summary:
- Branch: <branch>
- Action: <merged / PR created / kept / discarded>
- Base branch: <base>
- Worktree: <removed / preserved / n/a>
- Test status: passing
```

## Red Flags

Watch for these signs of premature completion claims:

| Statement | Problem |
|-----------|---------|
| "It should work" | No verification run |
| "Tests passed last time" | Not fresh evidence |
| "I will clean up later" | Later never comes |
| "Just merge it" | No option presented |
| "I already tested" | No evidence shown |
| "Let me just push first" | Skipping the decision |

## Worktree Policy Summary

| Option | Worktree Cleanup |
|--------|------------------|
| Merge to base | REMOVE worktree |
| Push + PR | PRESERVE worktree |
| Keep branch | PRESERVE worktree |
| Discard branch | REMOVE worktree |

## Subagent Integration

For parallel verification of test suites across multiple environments:

```python
august__spawn_subagent(
    goal="Run full test suite on branch <branch> and report results",
    context="Run pytest -q, capture full output, report pass/fail with counts.",
    toolsets=["terminal"]
)
```

When ready, load the verification-before-completion skill via august__load_skill before entering Phase 1.
