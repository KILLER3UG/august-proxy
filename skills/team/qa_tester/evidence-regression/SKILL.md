---
name: evidence-regression
description: Create evidence-based QA plans, run relevant tests, and report regression status for August changes
trigger: qa review, regression test, verify change, test plan, quality gate, qa tester
---
Use this skill when validating August changes. The goal is not to say "looks good"; the goal is to produce verifiable evidence.

## Research-backed QA model

- MetaGPT's QA role writes tests, runs them, and loops on failures.
- CrewAI-style tasks should have clear expected output and acceptance criteria.
- OpenAI's AI-native engineering guidance emphasizes evaluation loops: tests, benchmarks, latency targets, and style checks.
- August QA should combine code inspection, command evidence, and user-visible behavior.

## Workflow

1. Identify changed files and intended behavior.
2. Determine affected areas:
   - frontend UI
   - backend routes
   - Workbench tools
   - memory services
   - provider/catalog behavior
   - deployment/build scripts
3. Build a verification matrix:
   - expected behavior
   - command or inspection
   - pass/fail evidence
   - file paths
4. Run the narrowest tests first.
5. Escalate to broader tests only when needed.
6. If a test fails:
   - capture exact command
   - capture exact error
   - classify as blocker, flaky, unrelated, or expected
   - route back to the owner agent with a concrete fix request
7. Do not mark the change verified until at least one concrete evidence source is present.

## Evidence sources

Use any combination of:

- `npm test`
- `npm run test:backend`
- `npm run test:memory`
- `npm run test:frontend`
- `node --test <target>`
- `npm run build -w web`
- `curl` against running backend endpoints
- browser console output
- screenshot or visual comparison when UI changed
- git diff review
- runtime logs

## Test priority

1. Existing targeted tests for touched files
2. New or updated tests for changed behavior
3. Full package tests
4. Manual HTTP/UI checks when automated coverage is missing

## Output format

Return:

```text
qa status: pass | fail | blocked
evidence:
- command: <exact command>
  result: <exit code or response summary>
- command: <exact command>
  result: <exit code or response summary>

regressions:
- <none or concrete issue>

follow-ups:
- <owner or next action>
```

## Pitfalls

- Do not treat "tests not run" as QA pass.
- Do not hide failing tests under a broad success claim.
- Do not verify only the changed file; check call sites and routes.
- Do not run deploy/build side effects without approval.
- Do not include secrets from logs, env, or responses.
