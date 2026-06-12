---
name: api-contract-review
description: Review and evolve August backend API/tool contracts with provider, Workbench, and memory behavior in mind
trigger: backend api review, api contract, route review, tool contract, provider adapter, backend change
---
Use this skill when reviewing or changing August backend APIs, tool contracts, routes, provider adapters, Workbench backend behavior, or memory-related backend services.

## Review sources

Research-backed patterns used:

- MetaGPT-style roles separate planning, engineering, and QA responsibilities.
- CrewAI-style agents work from clear role, goal, expected output, and task dependencies.
- OpenAI's AI-native engineering guidance emphasizes code-aware planning, tool execution, persistent project memory, and evaluation loops.
- August should keep backend changes evidence-driven: route behavior, tests, logs, and API responses matter more than assumptions.

## Workflow

1. Identify the contract boundary:
   - HTTP route path and method
   - request body/query/path params
   - response shape and status codes
   - error shape
   - auth/env assumptions
   - side effects
2. Trace all call sites before editing:
   - backend route handlers
   - frontend API client calls
   - tool definitions
   - Workbench execution paths
   - tests
   - docs
3. Preserve existing conventions:
   - use `readJsonBody` for JSON request bodies
   - return JSON errors through `sendError`
   - keep Node backend code in CommonJS where existing files use `require/module.exports`
   - keep frontend API client typed and stable
   - avoid secrets in responses
4. For provider/model changes:
   - inspect `backend/providers`
   - inspect `backend/services/catalog/model-catalog.js`
   - verify `name`, `provider`, `displayName`, `isFree`, `id`, and capability fields
5. For Workbench/tool changes:
   - inspect `backend/services/workbench/workbench.js`
   - inspect tool registry registration
   - verify approval gate behavior for mutating tools
6. For memory changes:
   - inspect `backend/services/memory`
   - check core memory budget limits
   - check semantic memory provenance
   - check learning status endpoints
7. Add or update tests for the contract if practical.
8. Run targeted tests before claiming completion.

## Verification commands

Use the relevant commands for the changed area:

```sh
npm test
node --test backend/test/verification.test.js
node --test backend/test/memory-evals.test.cjs backend/test/memory-quality.test.cjs
npm run test -w web
```

For route behavior, verify with real HTTP responses when possible:

```sh
curl -sS http://127.0.0.1:9192/ui/models/catalog
curl -sS http://127.0.0.1:9192/ui/memory/learning-status
```

## Output format

Report:

- contract reviewed
- files changed
- behavior preserved
- behavior changed
- tests run
- risks or follow-ups

## Pitfalls

- Do not change response shape without checking frontend callers.
- Do not expose API keys, tokens, passwords, connection strings, or credentials.
- Do not use `/api/models` as a startup readiness probe; it can be slow. Use `/api/health/detailed` for readiness.
- Do not treat a route as fixed until the actual HTTP response is verified.
- Do not load another team's skill unless `canCrossLoadTeamSkills(agentId)` allows it.
