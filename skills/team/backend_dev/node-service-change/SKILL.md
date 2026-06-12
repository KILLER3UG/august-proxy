---
name: node-service-change
description: Implement backend Node service changes safely across routes, tools, Workbench, memory, providers, and tests
trigger: backend implementation, node service change, route implementation, tool implementation, workbench backend
---
Use this skill when implementing backend changes in August Proxy.

## Scope

This skill covers:

- `backend/index.js`
- `backend/routes/*`
- `backend/services/workbench/*`
- `backend/services/tools/*`
- `backend/services/memory/*`
- `backend/providers/*`
- `backend/services/catalog/*`
- backend tests under `backend/test/*`

## Workflow

1. Read the relevant files before editing.
2. Trace symbols to definitions and usages.
3. Identify the smallest integration points.
4. Preserve existing module style:
   - CommonJS files use `require()` and `module.exports`
   - ESM files use `import`/`export`
5. Add imports only when used.
6. Keep mutating backend changes behind Workbench approval gates.
7. Prefer helper functions over duplicated logic.
8. Avoid reformatting unrelated code.
9. Update docs only when behavior changes.
10. Verify with targeted tests and `npm test` when practical.

## Backend conventions

### Routes

- parse URLs with `new URL(req.url, 'http://localhost')` when query params matter
- restore `req.url` to the original string if it was replaced temporarily
- use `readJsonBody(req)` for JSON bodies
- use `sendJson(res, payload, statusCode?)`
- use `sendError(res, error, statusCode?)`
- return `false` from route interceptors so downstream handlers still run

### Tools

- keep tool names stable
- update both tool definition and execution branch
- include clear error messages
- validate required args before side effects
- never print secrets

### Workbench

- do not bypass approval gates
- team agents can have full tools, but mutating actions still require an approved plan
- `august__run_team` should select agents and preserve inherited approval policy
- `august__load_skill` should respect team skill ownership

### Memory

- core memory budgets:
  - `user_profile`: 3000 chars
  - `global_context`: 4000 chars
- write core memory only after validating budgets
- preserve provenance for semantic facts
- use temp paths in tests for memory files

## Verification checklist

- targeted Node tests pass
- backend verification route responds
- no unhandled circular dependency warnings
- no secrets in logs or responses
- full `npm test` passes when practical

## Output format

Return:

```text
backend change: <summary>
files: <paths>
tests: <commands and results>
risks: <none or follow-ups>
```
