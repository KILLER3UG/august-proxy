# API Reference

August Proxy exposes two API families from a single port (default `8085`):

- **`/v1/*`** — the AI proxy surface (OpenAI- and Anthropic-compatible), used by
  external clients like Claude Code, Codex, Cline, and Continue.dev.
- **`/api/*`** — the management/dashboard surface, used by the React/Tauri UI,
  mobile companion, and platform gateways.

All endpoints accept and return JSON unless noted. Streaming endpoints use
Server-Sent Events (`text/event-stream`). The Backend Monitor uses WebSocket
at `/api/logs/stream`.

OpenAPI is available when the server is running at `/docs` and `/openapi.json`.

---

## Table of Contents

1. [AI proxy endpoints (`/v1/*`)](#ai-proxy-endpoints-v1)
2. [Health & monitoring](#health--monitoring)
3. [Workbench (`/api/workbench`)](#workbench-apiworkbench)
4. [Configuration (`/api/config`)](#configuration-apiconfig)
5. [Providers & models](#providers--models)
6. [Skills & curator](#skills--curator)
7. [Agents & subagents](#agents--subagents)
8. [Memory & brain](#memory--brain)
9. [Live / voice](#live--voice)
10. [Gateway](#gateway)
11. [MCP & service connections](#mcp--service-connections)
12. [Terminal, browser, desktop](#terminal-browser-desktop)
13. [Automations, cron, exam, calendar](#automations-cron-exam-calendar)
14. [August manage / security / preview](#august-manage--security--preview)
15. [AUG.md / plans](#augmd--plans)
16. [Realtime & feature flow](#realtime--feature-flow)
17. [Event stream conventions](#event-stream-conventions)

---

## AI proxy endpoints (`/v1/*`)

### `POST /v1/messages`

Anthropic Messages API. Accepts the standard Anthropic request body (`model`,
`messages`, `system`, `tools`, `max_tokens`, `thinking`, `stream`). Returns
either a streamed SSE response (`stream: true`) or a JSON message.

The adapter resolves the model alias, injects the August system reminder
(optional AUG.md when `injectAugOnProxy` is on), canonicalizes tools, and — if
the upstream is OpenAI-format — translates the request and response. Managed
proxy tools are executed locally in a multi-round loop.

### `POST /v1/chat/completions`

OpenAI Chat Completions API. Passthrough with system-prompt injection, context
compaction hooks, and self-healing where applicable.

### `POST /v1/responses`

OpenAI Responses API. For non-native upstreams, the adapter can send a
Chat Completions request and synthesise a Responses-style SSE event sequence.

### `GET /v1/models`

Returns the model catalog (configured providers + aliases):

```json
{ "data": [ { "id": "claude-sonnet-4-6" }, { "id": "gpt-4o" } ] }
```

Also mirrored under management as `GET /api/models` (and catalog/capabilities/
aliases/cost helpers under `/api/models/*`).

---

## Health & monitoring

| Method & path | Purpose |
|---------------|---------|
| `GET /api/health` | **Single SoT** — `{status, version, python, port, uptime}` |
| `GET /api/health/detailed` | Extended snapshot (mode, data dir, external access, brain sync, cognitive) |
| `GET /api/activity` | Recent activity log |
| `GET /api/requests?status=&period=` | Tracked requests |
| `GET /api/requests/{id}` | Request detail (inspector) |
| `GET /api/details` / `GET /api/detail/{id}` | Detail variants |
| `GET /api/stats?period=` | Aggregate usage stats |
| `GET /api/conversations` | Conversation list for inspector |
| `GET /api/logs/recent` | Recent log events |
| `WS /api/logs/stream` | Live log stream (Backend Monitor) |
| `GET /api/host-agent/health` | Host-agent availability |
| `GET /api/perf/recent` | Perf ring buffer (when `AUGUST_PERF_TIMING=1`) |
| `GET /api/perf/db-writer` | db_writer lag stats |
| `GET /api/audit` / `GET /api/audit/stats` | Audit listing |
| `GET /api/usage` | Usage endpoints (see `routers/usage.py`) |

> Historical note: an earlier dual registration of `/api/health` dropped the
> `python` field. That collision is **fixed** — only `main.py` defines health,
> and the response includes both app and gateway poll fields.

---

## Workbench (`/api/workbench`)

All paths below are relative to `/api/workbench`.

### Sessions

| Method & path | Purpose |
|---------------|---------|
| `POST /sessions` | Create a session |
| `GET /sessions` | List sessions (summaries) |
| `GET /sessions/{id}` | Get a session (full) |
| `GET /session?sessionId=` | Get by query (singular alias) |
| `POST /session` | Create (singular alias) |
| `DELETE /sessions/{id}` | Delete |
| `PATCH /sessions/{id}/title` | Rename |
| `POST /session/rename` | Rename (body) |
| `POST /sessions/{id}/reset` | Reset |
| `GET /sessions/{id}/status` | Flat status for approval banner |
| `POST /sessions/{id}/agent` | Bind / clear agent |
| `GET /sessions/{id}/checkpoints` | List checkpoints |
| `POST /sessions/{id}/checkpoints/{checkpoint_id}/restore` | Restore |
| `GET /sessions/{id}/agents` | Bound agents |
| `POST /sessions/{id}/agents/cancel-all` | Cancel sub-agents |
| `POST /sessions/{id}/isolate-subagents` | Isolation control |
| `POST /sessions/{id}/worktree` | Worktree helper |
| `POST /sessions/{id}/undo-last-turn` | Undo last turn |
| `POST /sessions/{id}/branch` | Branch session |
| `POST /sessions/{id}/compact` | Force context compact |

### Chat

| Method & path | Purpose |
|---------------|---------|
| `POST /chat` | Start generation; returns `{sessionId, sinceSeq}` immediately |
| `GET /chat/stream?sessionId=&sinceSeq=` | SSE stream of chat events |
| `POST /chat/stop` | Abort (`{sessionId}`) |
| `GET /chat/active` | Active-session counts |
| `POST /chat/queue` · `GET /chat/queue` · `PATCH` · `DELETE` | Message queue |
| `POST /chat/steer` | Steer mid-flight |

### Plans, todos, mutations, goals

| Method & path | Purpose |
|---------------|---------|
| `POST /plan` | Submit a plan |
| `POST /plan/approve` · `/plan/reject` | Approve / reject plan |
| `POST /todos` · `PATCH /todos` | Todo list |
| `POST /mutations/respond` · `/confirm-mutation` | Mutation gate |
| `POST /goal` | Set / clear / status goal |
| `POST /guard-mode` | Change guard mode |
| `POST /btw` | Side question helper |

### Capabilities & tooling

| Method & path | Purpose |
|---------------|---------|
| `GET /activity` | Recent workbench activity |
| `GET /capabilities` | Tools grouped by source |
| `GET /agents` | Agents for UI tab |
| `GET /tool-grants` · `DELETE /tool-grants` | Tool grant list |
| `POST /sandbox/python` | Python sandbox exec |
| `GET /skills/hub` | Skills hub payload |
| `GET /doctor` | Session doctor diagnostics |

---

## Configuration (`/api/config`)

| Method & path | Purpose |
|---------------|---------|
| `GET /activeProvider` | Active provider + providers with keys |
| `GET /provider-details` · `POST /provider-details` | Provider detail CRUD helper |
| `GET /safe` | Full config bootstrap for dashboard |
| `GET/PUT /model-aliases` | Model alias list |
| `GET/PUT /subagent-fallback` · `POST …/test` | Sub-agent fallback |
| `GET/PUT /background-review` | Background review LLM |
| `GET/PUT /model-fleet` | Cognitive model fleet |
| `GET/PUT /cognitive` | Cognitive config tree |
| `GET/PUT /session-export` | JSON session export toggle / status |
| `GET/PUT /live` | Live / speech config |
| `GET/PUT /external-access` · `POST …/generate-key` | External gateway access |
| `GET/PUT /inject-aug-on-proxy` | Inject AUG.md on `/v1/*` path |

---

## Providers & models

### `/api/providers`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/providers` | List configured providers |
| `GET /api/providers/templates` | Built-in templates |
| `POST /api/providers` | Add provider |
| `POST /api/providers/import-config` | Import config |
| `GET/PUT/PATCH/DELETE /api/providers/{id}` | CRUD |
| `POST /api/providers/{id}/models/refresh` | Refresh model list |
| `POST/PATCH/DELETE …/models…` | Model CRUD / test |

### `/api/models`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/models` | Model list |
| `GET /api/models/catalog` | Catalog |
| `GET /api/models/capabilities` | Capabilities |
| `GET /api/models/aliases` | Aliases view |
| `POST /api/models/estimate-cost` | Cost estimate |

### `/api/manage`

Snapshot, alias CRUD, settings put — operator convenience surface.

---

## Skills & curator

### `/api/skills`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/skills?q=&category=` | Search/list |
| `GET /api/skills/{name}` | Full skill |
| `POST /api/skills` | Create agent-authored |
| `PATCH /api/skills/{name}` | Patch (copy-on-write for bundled) |
| `DELETE /api/skills/{name}` | Delete agent-authored |
| `POST/DELETE …/files` | Support files |

### `/api/curator`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/curator/usage` | Usage telemetry |
| `POST /api/curator/pin/{name}` · `/unpin/{name}` | Pin control |
| `POST /api/curator/archive/{name}` · `/restore/{name}` | Lifecycle |
| `POST /api/curator/run?dry_run=` | Run curation pass |

---

## Agents & subagents

### `/api/agents`

| Method & path | Purpose |
|---------------|---------|
| `GET/POST /api/agents` | List / create |
| `GET /api/agents/tree` | Recursive tree |
| `GET/PUT/DELETE /api/agents/{id}` | CRUD |
| `GET /api/agents/{id}/tree` | Agent + children |
| `POST/GET /api/agents/jobs` · `GET …/jobs/{id}` | Jobs |

### `/api/subagents`

| Method & path | Purpose |
|---------------|---------|
| `POST /api/subagents/spawn` | Spawn |
| `GET /api/subagents/active` | Active tasks |
| `POST /api/subagents/{taskId}/terminate` | Terminate |
| `POST /api/subagents/propose-breakdown` | Breakdown proposal |
| `GET /api/subagents/stream` | SSE status stream |

### `/api/sessions`

Separate session store API (list/create/get/delete/messages) used by some
dashboard paths alongside workbench sessions.

---

## Memory & brain

### `/api/memory`

KV, facts, search, proposals, lifecycle, stats — see `routers/memory.py`.

### `/api/brain`

| Area | Paths (representative) |
|------|------------------------|
| Dashboard | `GET /status`, `/items`, `/vectors`, `/learning`, `/prompt`, `/search`, `/guidelines`, `/graph`, `/diagnostics` |
| Config | `GET/PUT /config`, `POST /config/reset`, `GET /config/from-session` |
| Activity | `GET /events`, `GET /events/stream` |
| Lifecycle | `GET/PUT /delta-consent`, heuristics patch/delete, skill approve/reject, `POST /run-consolidation`, `GET /sync-status`, `POST /backfill-workbench`, `GET /health` |

---

## Live / voice

| Method & path | Purpose |
|---------------|---------|
| `POST /api/live/session` | Create live session |
| `POST /api/live/turn` | Process turn |
| `POST /api/live/stt` · `/stt/upload` | Server STT (optional) |
| `POST /api/live/tts` | Server TTS (optional) |

Unconfigured speech backends return **501** with a clear message. Prefer browser
speech unless a speech-capable provider is configured.

---

## Gateway

| Method & path | Purpose |
|---------------|---------|
| `POST /api/gateway/telegram/webhook` | Telegram updates |
| `GET /api/gateway/status` | Running adapters summary |

Enablement: `config.json → gateway` + platform bot tokens.

---

## MCP & service connections

### MCP (`/api/mcp`)

| Method & path | Purpose |
|---------------|---------|
| `GET /api/mcp/servers` · `POST` · `GET/{id}` · `DELETE/{id}` | Server CRUD |
| `POST …/start` · `…/stop` | Process control |
| `GET /api/mcp/directory` | Directory listing |
| `GET /api/mcp/tools` | Aggregated tools |
| `GET /api/mcp/config` | Config snapshot |

### Service connections

| Method & path | Purpose |
|---------------|---------|
| `GET /api/service-connections` | List |
| `POST …/github` · `…/slack` · `…/google` | Connect |
| `POST …/github/test` · `…/slack/test` | Test |
| `GET …/github/scopes` · `…/slack/scopes` | Scopes |
| `POST …/google/auth` · `GET …/google/callback` | OAuth |
| `DELETE /api/service-connections/{name}` | Disconnect |
| `GET/POST /api/mcp-env` | Global MCP env |

---

## Terminal, browser, desktop

| Prefix | Purpose |
|--------|---------|
| `/api/terminal` · terminal WS routes | PTY sessions, buffer, I/O |
| `/api/browser/screenshot` | Screenshot fetch |
| `/api/desktop-automation/health` · `/config` · `/action` | Desktop control |
| `/api/git/*` | status, log, branch, diff, checkout, commit, command |

---

## Automations, cron, exam, calendar

| Prefix | Purpose |
|--------|---------|
| `/api/automations` | List/create/run/delete automation jobs |
| `/api/cron` | Cron jobs CRUD, toggle, run |
| `/api/exam` | Generate exam, questions, answer, help |
| `/api/calendar/internal` | Internal calendar helper |

---

## August manage / security / preview

### `/api/august`

Unified manage actions used by the UI and agent self-config tools:

| Method & path | Purpose |
|---------------|---------|
| `POST /aliases/manage` | list / upsert / delete aliases |
| `GET /audit` | Config-change audit log |
| `GET /rollback` · `POST /rollback/{id}/undo` | Rollback list / undo |
| `POST /settings/update` | Settings patch |
| `POST /models/select` | Model selection |
| `POST /sessions/manage` | Session actions |
| `POST /providers/manage` | Provider actions |
| `POST /agents/manage` | Agent actions |
| `POST /memory/manage` | Memory actions |
| `POST /tools/manage` | Tool / MCP actions |
| `POST /computer/app-policy` | Computer-use policy |
| `POST /ui-action` · `GET /ui-events` | UI action bridge |

### Security / overview (`routers/security.py`)

| Method & path | Purpose |
|---------------|---------|
| `GET/PUT /api/security` | Security config |
| `GET /api/rollback` | Security-facing rollback list |
| `GET /api/observations` · `…/{id}.png` | Observation gallery |
| `GET /api/observability/overview` | Observability overview |
| `POST /api/system/restart` | Restart signal |
| `GET /api/workspace/files` | Workspace file listing |
| `GET /api/overview` | App overview |

### Preview

| Method & path | Purpose |
|---------------|---------|
| `GET/POST /api/preview/sessions` | Preview sessions |
| `GET/DELETE /api/preview/session/{id}` | Get / delete |
| `POST /api/preview/approve` | Approve preview |

---

## AUG.md / plans

| Method & path | Purpose |
|---------------|---------|
| `GET /api/aug/context` | Loaded AUG context |
| `POST /api/aug/init` | Generate / refine AUG.md |
| `PUT/DELETE /api/aug/content` | Write / clear content |
| `GET /api/aug/plans` · `DELETE /api/aug/plans/{kind}/{slug}` | Plan/todo artifacts |

---

## Realtime & feature flow

| Method & path | Purpose |
|---------------|---------|
| `GET /api/realtime/stream` | Realtime event stream |
| `GET /api/realtime/recent` | Recent realtime events |
| `GET /api/monitor/features` | Feature catalog |
| `GET /api/monitor/events` · `/events/stream` | Feature-flow events (Settings → Feature Flow) |

---

## Event stream conventions

`GET /api/workbench/chat/stream` yields SSE events:

```
event: <type>
data: <json payload>
id: <seq>

```

Common event types:

| Type | When | Payload (typical) |
|------|------|-------------------|
| `started` | Generation begins | `{sessionId, model}` |
| `final_output` | Model text delta | `{content}` |
| `thinking` | Reasoning delta | `{content}` |
| `tool_call` | Tool starting | `{id, name, status:"running"}` |
| `tool_result` | Tool finished | `{id, name, content, status, …}` |
| `plan_proposed` | Plan submitted | `{plan}` |
| `compaction` | Context compressed | token counts |
| `session_status` | Status changed | guard/status fields |
| `error` | Error | `{message}` |
| `aborted` | Cancelled | `{}` |
| `done` | Generation complete | `{sessionId}` |
| `keepalive` | Idle | comment line `: keepalive` |

The stream terminates after `done`, `error`, or `aborted`. Pass the last `id`
as `sinceSeq` on reconnect to resume without gaps.
