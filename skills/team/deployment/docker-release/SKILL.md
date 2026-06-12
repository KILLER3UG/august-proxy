---
name: docker-release
description: Plan and execute safe Docker/build/deploy work for August Proxy with approval gates and smoke checks
trigger: deployment, docker, build release, deploy, container, smoke test, deployment agent
---
Use this skill for Docker, build, release, and deployment work. Deployment is high-risk: prefer planning and verification first, then mutate only after approval.

## Research-backed deployment model

- CrewAI-style deployment tasks should have explicit expected output and rollback notes.
- OpenAI's AI-native engineering guidance treats evaluation loops and production-readiness checks as essential.
- Docker deployment should be deterministic: build, inspect, run, smoke test, then release.
- August must preserve Workbench approval gates for shell, deploy, and host-changing actions.

## Scope

This skill covers:

- `Dockerfile`
- docker build/run commands
- backend startup
- frontend build artifacts
- release commands
- smoke checks
- port checks
- container health
- rollback notes

## Workflow

1. Confirm the requested deployment target:
   - local build only
   - Docker build only
   - container run
   - production deploy
   - release packaging
2. Inspect current deployment files before editing.
3. If editing is needed, keep changes minimal and explain why.
4. Submit an approval plan before running mutating commands.
5. Run non-mutating checks first:
   - inspect Dockerfile
   - inspect package scripts
   - inspect backend startup port
   - inspect env assumptions
6. Run mutating commands only after approval:
   - docker build
   - npm build
   - container run
   - deploy/release command
7. Smoke test:
   - backend health or catalog endpoint
   - frontend build success
   - expected port availability
   - no leaked secrets in logs
8. Provide rollback notes.

## Common commands

Non-mutating:

```sh
npm run test:verify
npm run build -w web
node -e "require('./backend/services/catalog/model-catalog').list({ deprecated: false })"
```

Mutating or side-effecting, require approval:

```sh
docker build -t august-proxy .
docker run --rm -p 8080:8080 august-proxy
npm run launch
```

## Smoke checks

```sh
curl -sS http://127.0.0.1:8080/api/health/detailed
curl -sS http://127.0.0.1:8080/ui/models/catalog
```

If using a custom port, replace `8080` with the configured port.

## Output format

Return:

```text
deployment status: planned | approved | built | running | failed | rolled_back
commands run:
- <exact command>
  result: <result>

smoke checks:
- <endpoint or command>
  result: <result>

rollback:
- <steps or not applicable>
```

## Pitfalls

- Do not deploy without explicit approval.
- Do not expose secrets in logs or responses.
- Do not assume Docker build succeeded; verify the artifact or image exists.
- Do not claim production readiness without smoke checks.
- Do not run long-lived servers in the foreground without tracking and cleanup.
