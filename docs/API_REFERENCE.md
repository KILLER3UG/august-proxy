# API Reference

August Proxy exposes two API families from a single port (default `8085`):

- **`/v1/*`** — the AI proxy surface (OpenAI- and Anthropic-compatible), used by
  external clients like Claude Code, Codex, Cline, and Continue.dev.
- **`/api/*`** — the management/dashboard surface, used by the React UI and
  platform gateways.

All endpoints accept and return JSON unless noted. Streaming endpoints use
Server-Sent Events (`text/event-stream`).

---

## Table of Contents

1. [AI proxy endpoints (`/v1/*`)](#ai-proxy-endpoints-v1)
2. [Workbench (`/api/workbench`)](#workbench-apiworkbench)
3. [Configuration (`/api/config`)](#configuration-apiconfig)
4. [Providers & models](#providers--models)
5. [Skills (`/api/skills`) & curator (`/api/curator`)](#skills--curator)
6. [Agents (`/api/agents`)](#agents-apiagents)
7. [Gateway (`/api/gateway`)](#gateway-apigateway)
8. [Monitoring (`/api/*`)](#monitoring-api)
9. [Management (`/api/manage`, `/api/august`)](#management)
10. [Event stream conventions](#event-stream-conventions)

---

## AI proxy endpoints (`/v1/*`)

### `POST /v1/messages`

Anthropic Messages API. Accepts the standard Anthropic request body (`model`,
`messages`, `system`, `tools`, `max_tokens`, `thinking`, `stream`). Returns
either a streamed SSE response (`stream: true`) or a JSON message.

The adapter resolves the model alias, injects the August system reminder,
canonicalizes tools, and — if the upstream is OpenAI-format — translates the
request and response. Managed proxy tools are executed locally in a multi-round
loop.

### `POST /v1/chat/completions`

OpenAI Chat Completions API. Mostly passthrough with system-prompt injection,
context compaction, and self-healing.

### `POST /v1/responses`

OpenAI Responses API. For non-native upstreams, the adapter sends a
non-streaming Chat Completions request and synthesises the Responses SSE
event sequence (`response.created` → `response.in_progress` → text deltas →
`response.completed` → `[DONE]`).

### `POST /v1/messages/count_tokens`

Returns a lightweight token estimate:

```json
{ "input_tokens": 1234, "estimated": true }
```

### `GET /v1/models`

Returns the model catalog (built-in providers + custom providers + aliases):

```json
{ "data": [ { "id": "claude-sonnet-4-6" }, { "id": "gpt-4o" } ] }
```

---

## Workbench (`/api/workbench`)

### Sessions

| Method & path | Purpose |
|---------------|---------|
| `POST /sessions` | Create a session (body: `provider`, `agentId`, `guardMode`, `task`, `goal`) |
| `GET /sessions` | List all sessions (summaries) |
| `GET /sessions/{id}` | Get a session (full) |
| `GET /session?sessionId=` | Get a session by query param (singular alias) |
| `POST /session` | Create a session (singular alias) |
| `DELETE /sessions/{id}` | Delete a session |
| `POST /sessions/{id}/reset` | Reset (delete + recreate) |
| `GET /sessions/{id}/status` | Flat status for the approval banner |
| `GET /session/{id}/status` | Singular alias of the above |
| `POST /sessions/{id}/agent` | Bind (or clear with empty `agentId`) an agent |

### Chat

| Method & path | Purpose |
|---------------|---------|
| `POST /chat` | Start a generation; returns `{sessionId, sinceSeq}` immediately |
| `GET /chat/stream?sessionId=&sinceSeq=` | SSE stream of chat events |
| `POST /chat/stop` | Abort a running generation (body: `{sessionId}`) |
| `GET /chat/active` | Active-session counts |

`POST /chat` body: `sessionId`, `message`, `provider`, `agentId`, `effort`,
`model`, `modelProvider`, `guardMode`. The actual model output is delivered
through the SSE stream (see [event stream conventions](#event-stream-conventions)).

### Plans & mutations

| Method & path | Purpose |
|---------------|---------|
| `POST /plan` | Submit a plan (body: `sessionId`, `plan`) |
| `POST /plan/approve?sessionId=` | Approve a pending plan |
| `POST /plan/reject?sessionId=` | Reject a pending plan |
| `POST /mutations/respond` | Approve/reject a pending mutation (body: `token`, `reject`) |

### Goals & capabilities

| Method & path | Purpose |
|---------------|---------|
| `POST /goal` | Set/clear/status a goal (body: `sessionId`, `action`, `condition`) |
| `GET /activity` | Recent workbench activity counts |
| `GET /capabilities` | All tools grouped by source |
| `GET /agents` | List agents (for the UI Agents tab) |

---

## Configuration (`/api/config`)

| Method & path | Purpose |
|---------------|---------|
| `GET /activeProvider` | Active provider + providers with configured keys |
| `GET /safe` | Full `config.json` (dashboard bootstrap) |
| `GET /model-aliases` | All model-alias entries |
| `PUT /model-aliases` | Replace the alias list (validated) |
| `GET /subagent-fallback` | Current sub-agent fallback config |
| `PUT /subagent-fallback` | Update fallback fields (partial) |
| `POST /subagent-fallback/test` | Probe model resolution without saving |
| `GET /background-review` | Current background-review config |
| `PUT /background-review` | Update background-review config (partial) |

---

## Providers & models

| Method & path | Purpose |
|---------------|---------|
| `GET /api/providers` | List built-in + custom providers |
| `POST /api/providers` | Add a custom provider |
| `PUT /api/providers/{id}` | Update a custom provider |
| `DELETE /api/providers/{id}` | Remove a custom provider |
| `GET /api/providers/{id}/models` | Fetch/refresh a provider's model list |
| `POST /api/providers/{id}/discover` | Discover added/updated/removed models |

---

## Skills & curator

### `/api/skills`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/skills?q=&category=` | Search/list skills |
| `GET /api/skills/{name}` | Get a skill (full body) |
| `POST /api/skills` | Create an agent-authored skill |
| `PATCH /api/skills/{name}` | Patch a skill (copy-on-write for bundled) |
| `DELETE /api/skills/{name}` | Delete an agent-authored skill (refuses bundled) |
| `POST /api/skills/{name}/files` | Write a support file |
| `DELETE /api/skills/{name}/files?file_path=` | Remove a support file |

### `/api/curator`

| Method & path | Purpose |
|---------------|---------|
| `GET /api/curator/usage` | Usage telemetry for tracked skills |
| `POST /api/curator/pin/{name}` | Pin a skill (exempt from auto-transitions) |
| `POST /api/curator/unpin/{name}` | Unpin a skill |
| `POST /api/curator/archive/{name}` | Archive an agent-authored skill |
| `POST /api/curator/restore/{name}` | Restore an archived skill |
| `POST /api/curator/run?dry_run=` | Run a curation pass now |

---

## Agents (`/api/agents`)

| Method & path | Purpose |
|---------------|---------|
| `GET /api/agents` | List all agents |
| `POST /api/agents` | Create an agent |
| `GET /api/agents/tree?root=&maxDepth=` | Recursive agent tree |
| `GET /api/agents/{id}` | Get an agent |
| `PUT /api/agents/{id}` | Update an agent |
| `DELETE /api/agents/{id}` | Delete an agent |
| `GET /api/agents/{id}/tree` | Agent + direct children |
| `POST /api/agents/jobs` | Create a sub-agent job |
| `GET /api/agents/jobs?agent_id=` | List jobs |
| `GET /api/agents/jobs/{id}` | Get a job |

Agents are persisted (SQLite KV) and survive restarts.

---

## Gateway (`/api/gateway`)

| Method & path | Purpose |
|---------------|---------|
| `POST /api/gateway/telegram/webhook` | Receive a Telegram update |
| `GET /api/gateway/status` | Summary of running adapters |

Gateway enablement and platform config live in `config.json → gateway`.

---

## Monitoring (`/api/*`)

| Method & path | Purpose |
|---------------|---------|
| `GET /api/health` | `{status, version, python}` |
| `GET /api/health/detailed` | `{status, mode, port, data_dir}` |
| `GET /api/activity` | Recent activity log |
| `GET /api/requests?status=&period=` | Tracked requests |
| `GET /api/requests/{id}` | Request detail (inspector) |
| `GET /api/stats?period=` | Aggregate usage stats |
| `GET /api/host-agent/health` | Host-agent availability |
| `GET /api/health` (gateway) | Gateway health (port, uptime) |

> **Note:** `/api/health` is registered twice — once by `monitoring.py` and
> once by `main.py`. The last registration wins; the gateway-variant response
> omits the `python` field. (See the review report's findings.)

---

## Management

### `/api/manage`

Provider/model management endpoints (PUT/PATCH/DELETE for providers and models).

### `/api/august`

| Method & path | Purpose |
|---------------|---------|
| `POST /api/august/aliases/manage` | Unified alias action (`list`/`upsert`/`delete`) |
| `GET /api/august/audit?category=&limit=` | Config-change audit log |
| `GET /api/august/rollback` | (Stub) rollback list |

### Other

`/api/memory`, `/api/sessions`, `/api/mcp`, `/api/cron`, `/api/git`,
`/api/terminal`, `/api/usage`, `/api/audit` — see the routers in
[`backend-py/app/routers/`](../backend-py/app/routers/) for details.

---

## Event stream conventions

`GET /api/workbench/chat/stream` yields SSE events. Each event has the form:

```
event: <type>
data: <json payload>
id: <seq>

```

Common event types:

| Type | When | Payload |
|------|------|---------|
| `started` | Generation begins | `{sessionId, model}` |
| `final_output` | Model text delta | `{content}` |
| `thinking` | Reasoning delta | `{content}` |
| `tool_call` | Tool starting | `{id, name, status:"running"}` |
| `tool_result` | Tool finished | `{id, name, content, status, ...}` |
| `plan_proposed` | Plan submitted | `{plan}` |
| `compaction` | Context compressed | `{originalTokens, compressedTokens, ...}` |
| `session_status` | Status changed | `{sessionId, status, guardMode, ...}` |
| `error` | Error | `{message}` |
| `aborted` | Cancelled | `{}` |
| `done` | Generation complete | `{sessionId}` |
| `keepalive` | Idle (30s) | comment line `: keepalive` |

The stream terminates after `done`, `error`, or `aborted`. Clients should pass
the last `id` (seq) as `sinceSeq` on reconnect to resume without gaps.
