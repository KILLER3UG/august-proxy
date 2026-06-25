---
name: verification-before-completion
description: "No completion claims without fresh verification evidence."
trigger: "before committing, creating PRs, or claiming work is complete"
version: 1.0.0
author: August Proxy (adapted from obra/superpowers)
license: MIT
---

# Verification Before Completion

## Overview

A rigid enforcement skill that prevents completion claims without fresh, verified evidence. Every "it works" or "it is done" must be backed by a command run in this session whose output confirms the claim.

**Core principle:** Evidence must be fresh. Evidence must be explicit. No evidence means not done.

## The Iron Law

```
NO COMPLETION CLAIM WITHOUT FRESH VERIFICATION EVIDENCE
```

If you cannot point to a command output (exit code + failure count) from this session that proves the claim, the claim is unsupported and must not be made.

## When to Use

Use this skill **EVERY TIME** before:
- Stating "tests pass"
- Stating "work is complete"
- Stating "the bug is fixed"
- Creating a commit
- Creating a pull request
- Merging a branch
- Switching to a new task
- Marking a todo as complete
- Telling a user "ready for review"

**Use it even when:**
- The change was "just a comment" (formatting might break linting)
- The change was "just a config" (config errors cause silent failures)
- You are "sure it works" (certainty is not evidence)
- Tests "passed before" (irrelevant, run them again)

## The Process

You MUST complete all four steps in order. Skipping any step is a violation.

### Step 1: IDENTIFY

**State the claim you want to make.** Then identify the exact command that proves it.

| Claim | What Proves It | Command |
|-------|----------------|---------|
| "Tests pass" | Exit code 0, 0 failures | pytest -q |
| "Lint passes" | No lint errors | ruff check . |
| "Bug is fixed" | Regression test passes | pytest <test-path> -v |
| "Build succeeds" | Exit code 0 | python -m build |
| "Feature works" | Integration test passes | pytest tests/integration/ -v |
| "No TypeScript errors" | Exit code 0 | tsc --noEmit |
| "Code formatted" | No diff | ruff format --check . |
| "Coverage acceptable" | Coverage >= threshold | pytest --cov=<module> --cov-fail-under=80 |

**Action:** Write down the claim and the command explicitly before proceeding.

### Step 2: RUN

Run the full command fresh. Do not use cached results. Do not rely on "I ran it earlier."

```
august__run_command <command>
```

**Rules:**
- Run the COMPLETE command, not a subset
- Run from the project root
- Capture ALL output (stdout and stderr)
- Do not abbreviate or truncate the output
- Do not skip this step because "it takes too long"

### Step 3: READ

Read the full output carefully.

Check:
1. **Exit code** -- Did the command exit with 0?
2. **Failure count** -- Does the output say "0 failed", "0 errors", "all checks passed"?
3. **Error messages** -- Are there any WARNING, ERROR, or FAILED lines?
4. **Skipped tests** -- Are tests being skipped that should not be?

**Output interpretation table:**

| Output Signal | Meaning |
|---------------|---------|
| Exit code 0, "0 failed" | PASS -- claim supported |
| Exit code 0, "1 failed" | FAIL -- claim not supported |
| Exit code 0, "3 warnings" | CAUTION -- review warnings before claiming done |
| Exit code 1 | FAIL -- command errored, claim not supported |
| Exit code 2 | FAIL -- command not found or misconfigured |
| "No tests ran" | FAIL -- test discovery failed, claim not supported |
| "Module not found" | FAIL -- dependency issue, claim not supported |
| Empty output (no errors, no summary) | INCONCLUSIVE -- insufficient evidence |

### Step 4: VERIFY and CLAIM

**If output confirms the claim:**

Quote the relevant evidence explicitly:

```
Evidence:
<paste the exact output line proving the claim, e.g. "== 45 passed in 2.34s ==">
```

Then make the claim.

**If output does NOT confirm the claim:**

1. Do NOT make the claim
2. Report the actual result to the user
3. Load the systematic-debugging skill via august__load_skill
4. Do NOT proceed until the issue is resolved

## Rationalization Prevention

| Rationalization | Truth |
|-----------------|-------|
| "Tests passed in the last session" | That was a different agent context. Run them now. |
| "It is just one line, I do not need to test" | One-line changes break things constantly. Test it. |
| "The CI will catch it" | CI is not for catching what you can verify locally. |
| "I watched it work during development" | Watching it work once is not a test suite. |
| "The change is too minor to matter" | Minor changes have major consequences. Verify. |
| "Running tests takes too long" | Not running tests costs more time in debugging. |
| "I will verify after the claim" | Verification before or it did not happen. |
| "But it compiled" | Compilation does not equal correctness. Run the tests. |
| "I already verified this file" | You verified it before the change. Re-verify after. |
| "My IDE says it is fine" | IDE checks are not a test suite. Run the command. |
| "I am just saying it is ready for review" | Then verify before saying it. |

## Red Flags

If you hear yourself thinking or saying any of these, STOP and run verification:

- "Should be fine"
- "Pretty sure"
- "Probably works"
- "Let me just say it is done"
- "I will verify after committing"
- "Trust me"
- "It is obvious"
- "Everyone knows this works"
- "I did not change that part"
- "The tests are flaky anyway" (run them 3 times to confirm flakiness)
- "Let me check the output... yeah looks good" (read the output, do not skim)

## Subagent Integration for Parallel Verification

When verification needs to happen across multiple dimensions:

```python
august__spawn_subagent(
    goal="Verify all tests pass on branch <branch>",
    context="Run the complete test suite from project root. Report exit code, failure count, and any warnings. Do NOT skip this step.",
    toolsets=["terminal"]
)
```

## Chain to Next Skill

When verification passes and work is confirmed complete, load the finishing-a-development-branch skill via august__load_skill to decide how to integrate the work.

When verification fails, load the systematic-debugging skill via august__load_skill before attempting any fix.
