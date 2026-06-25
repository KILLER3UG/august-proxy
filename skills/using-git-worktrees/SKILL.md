---
name: using-git-worktrees
description: "Isolate work in a separate git worktree to keep the main workspace clean."
trigger: "starting feature work needing isolation"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Using Git Worktrees

## Overview

Isolate feature work in a separate git worktree so the main workspace stays clean. Worktrees allow you to work on multiple branches simultaneously without stashing or committing incomplete work.

**Core principle:** One workspace per task. Never mix unrelated changes in the same checkout.

## When to Use

- Starting a new feature that needs isolation
- Before executing implementation plans
- When you need to work on multiple branches simultaneously
- When the current workspace has uncommitted changes you don't want to disturb

## Workflow

### 1. Detect Existing Isolation

Check if you're already in an isolated environment:

```bash
git rev-parse --git-dir
git rev-parse --git-common-dir
```

If `--git-dir` differs from `--git-common-dir`, you're already in a worktree.

If you're inside a submodule, worktrees are not available — work directly in the submodule.

### 2. Create a Worktree

```bash
# Create a new branch and worktree
git worktree add ../<project>-<feature-branch> <feature-branch>

# Or check out an existing branch in a new worktree
git worktree add ../<project>-<existing-branch> <existing-branch>
```

Directory naming convention: `<project-dir>-<branch-name>`

### 3. Set Up the Project

Navigate to the new worktree and install dependencies:

```bash
cd ../<project>-<feature-branch>

# Node.js
test -f package-lock.json && npm ci
test -f yarn.lock && yarn --frozen-lockfile

# Rust
test -f Cargo.toml && cargo fetch

# Python
test -f requirements.txt && pip install -r requirements.txt
test -f pyproject.toml && pip install -e .
```

### 4. Verify Clean Baseline

Run the test suite to confirm everything passes before you start making changes:

```bash
# Run the project's test command
npm test
# or
cargo test
# or
pytest
```

If the baseline fails, report it to the user. Do not start implementation on a broken baseline.

## Cleanup

When the feature branch is merged, remove the worktree:

```bash
git worktree remove ../<project>-<feature-branch>
git branch -d <feature-branch>
```

## Red Flags

- **Working directly in the main workspace** — risk of mixing unrelated changes
- **Skipping dependency install** — missing packages cause confusing errors
- **Skipping baseline verification** — can't trust your changes if the baseline was already broken
- **Forgetting to remove the worktree** — stale worktrees accumulate on disk
