---
name: independent-review
description: "Review a code change from a clean context using only the diff, the requirement and the real test results. Use when the user asks for an independent review, a second opinion, or a pre-merge review; do not use it to review your own live reasoning or to write the change."
category: engineering
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [review, subagent, diff, merge]
    related_skills: [trajectory-review]
---

# Independent Review

The agent that wrote the code has already convinced itself of each small
decision. A reviewer that inherits that conversation tends to repeat the same
reasoning and miss the same defects. This procedure keeps the reviewer outside
the author's context.

## When to Use

- The user asks for an independent review, a second opinion, or a pre-merge
  review of a diff.
- You finished an implementation and want a check that does not trust your own
  summary.
- A change touches a boundary where "it looked right" is not enough:
  persistence, permissions, migration, retries, or a public interface.

## When NOT to Use

- You are still deciding what to build; review needs a requirement and a diff.
- You want a style pass on prose, not a correctness review.
- The "review" is an excuse to hand the whole author conversation to another
  model — that recreates the shared blind spot this procedure removes.

## Prerequisites

Collect exactly these three inputs:

1. **Diff** — `git diff <base>...HEAD`, or the staged diff. For a single
   uncommitted change, `git diff` is enough.
2. **Requirement** — the issue, spec, task description or acceptance criteria
   the change must satisfy. If it is missing, stop and ask for it; a review
   without a requirement can only check style.
3. **Test/build evidence** — the commands that were run and their real output,
   including failures and skipped checks. If nothing was run, say so; do not
   invent a green result.

Do **not** include the author's plan, intermediate reasoning, self-assessment
or chat history in the reviewer's input.

## How to Run

1. Put the three inputs in a file when they are long, or paste them into the
   reviewer's context.
2. Spawn a **read-only** subagent with `spawn_subagents`:
   - `capability`: `read_only`
   - `background`: `false` (you need the verdict before fixing)
   - `goal`: answer "does this change meet the requirement, and what can break?"
   - `context`: the three inputs, plus the repository path and the base commit.
3. Ask the reviewer to open the real code at each suspected location with
   `read_file` or `module_context`; a finding must name a file and a line, not
   a feeling.
4. Return to the main loop and verify each finding before changing anything.
5. Fix only confirmed findings; rerun the relevant build/test command and say
   what it actually reported.

## Quick Reference

| Input | Bad version | Good version |
| --- | --- | --- |
| Diff | "the auth change" | `git diff 4f2a1c...HEAD` |
| Requirement | "make login safer" | issue link + acceptance criteria |
| Evidence | "tests pass" | command, exit code, failing test names |

## Procedure

1. **Establish scope.** Name the base commit, the changed files and what is
   out of scope.
2. **Read the broad design first.** Does this change belong here? Is the
   abstraction appropriate now, not for a speculative future?
3. **Review every human-written line in scope.** Generated or mechanical
   output may be sampled; say so.
4. **Look for the usual unverified assumptions:** empty/null input, callers
   that "already validate", ordering, concurrency, retries, error paths, and
   state that survives a restart.
5. **Check requirement coverage** item by item. A passing test suite that tests
   the wrong behavior is not coverage.
6. **Check test quality:** would each test fail if the code were broken? Were
   the tests written by the same agent that wrote the code? If so, inspect what
   they actually assert.
7. **Check scope drift:** behavior changed outside the stated requirement.
8. **Return structured findings.** No finding is accepted without a location
   and a reason.

## Output Format

```markdown
## Findings
- [BLOCKER] path/file.ext:123 — Problem. Why it matters. Required change.
- [IMPORTANT] path/file.ext:45 — Problem. Why it matters. Suggested fix.
- [NIT] path/file.ext:88 — Optional polish.

## Requirement Coverage
- Covered: ...
- Missing: ...

## Verification
- Reviewed: <base>...HEAD, <file count> files
- Test evidence: <command> → <real result>
- Not reviewed: <scope or "none">

## Verdict
REQUEST_CHANGES | APPROVE_WITH_COMMENTS | APPROVE | NEEDS_SPECIALIST
```

Severity: `BLOCKER` must be fixed; `IMPORTANT` should be fixed or explicitly
justified; `NIT` must not block approval.

## Examples

A diff adds a cache keyed by a string that callers build from a file path. A
useful finding is: "`cache.py:42` keys on the raw path, but `read_file`
normalizes `~` and symlinks before use; two spellings of one file get two
entries." A useless finding is "the cache could be better."

## Pitfalls

- Passing the author's conversation to the reviewer. The reviewer then
  reviews the reasoning, not the code.
- Applying all findings without checking them. Reviewers can be wrong, and a
  finding without a reproducible failure is a hypothesis.
- Reviewing only the changed lines when the surrounding function changes the
  meaning of those lines.
- Accepting "tests pass" with no command or output.
- Turning a one-off review observation into a project-wide rule before it has
  happened twice.

## Verification

For each finding, before fixing:

1. Open the named file and line.
2. Reproduce the defect with a concrete input, a failing command or a minimal
   probe.
3. If it reproduces, fix it and rerun the relevant check.
4. If it does not, record the finding as rejected and why, so the next review
   does not raise it again.

## Reference Files

None. Keep the procedure and the three inputs in this file.

---

Adapted from `stacks/ronny/skills/independent-review` in
[MiniMax-AI/mcode-stack](https://github.com/MiniMax-AI/mcode-stack) (MIT,
Copyright (c) 2026 MiniMax Code). The full notice is in `NOTICE.md` in this
skill directory.
