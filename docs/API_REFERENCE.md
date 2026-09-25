# API Reference

August Proxy exposes two API families from a single port (default `8085`):

- **`/v1/*`** — the AI proxy surface (OpenAI- and Anthropic-compatible), used by
  external clients like Claude Code, Codex, Cline, and Continue.dev.
- **`/api/*`** — the management surface used by the **Tauri desktop app**,
  mobile companion, and platform gateways.

All endpoints accept and return JSON unless noted. Streaming endpoints use
Server-Sent Events (`text/event-stream`). Activity Log / live events use
WebSocket at `/api/logs/stream`.

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
13. [Automations, exam, calendar](#automations-cron-exam-calendar)
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

### `POST /v1/messages/count_tokens`

Estimated input-token count for the supplied messages/tools without making a
model call. Returns a local heuristic (no upstream `count_tokens` request):

```json
{ "input_tokens": 147, "estimated": true }
```

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
| `WS /api/logs/stream` | Live log stream (Activity Log; hidden Backend Monitor deep-link) |
| `GET /api/host-agent/health` | Host-agent availability |
| `GET /api/perf/recent` | Perf ring buffer (when `AUGUST_PERF_TIMING=1`) |
| `GET /api/perf/db-writer` | db_writer lag stats |
| `GET /api/audit` / `GET /api/audit/stats` | Audit listing |
| `POST /api/usage` | Record a usage event |
| `GET /api/usage/session?sessionId=` | Per-session usage |
| `GET /api/usage/stats?period=` | Aggregate usage (totals, sessions, messages, activeDays, favoriteModel…) — `currentStreak` is a placeholder, see [`GAPS_AND_BUGS.md`](GAPS_AND_BUGS.md) |
| `GET /api/usage/heatmap?period=` | Usage heatmap |
| `GET /api/usage/by-model?period=` | Usage grouped by model |
| `GET /api/usage/by-day?period=` | Usage grouped by day |
| `GET /api/usage` | List-all usage records |
| `GET /api/whats-new` | Changelog / what's-new feed for the desktop app |

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
| `POST /sessions/{id}/handoff` | Hand a session off (used by Live / agent flows) |
| `POST /sandbox-mode` | Toggle sandbox mode for the active session |
| `PATCH /sessions/{id}/sandbox` | Per-session sandbox override |

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
| `GET /sessions/{id}/transcript` | Recent messages (Workers drawer preview) |
| `POST /agent-mode` | Persist `chat` / `agent` / `code` / `orchestrator` |

### Harness jobs & workstreams (`/api/subagents`, `/api/harness`)

| Method & path | Purpose |
|---------------|---------|
| `GET /api/subagents/workstreams?sessionId=` | Named workstreams + latest episodes |
| `GET /api/subagents/workstreams/{name}/episodes` | Episode history for Continue |
| `POST /api/subagents/workstreams/{name}/continue` | Fresh worker on that thread |
| `GET /api/subagents/jobs` · `POST /api/subagents/jobs/{jobId}/cancel` | Long-running harness jobs |
| `GET /api/harness/*` · `GET /api/brain/harness/evals` | Trends + golden loop evals |
| `POST /api/mcp/harness` | MCP tools: `harness_list_workstreams`, `harness_spawn`, `harness_steer`, `harness_continue`, `harness_list_jobs`, `harness_cancel_job` |

---

## Configuration (`/api/config`)

| Method & path | Purpose |
|---------------|---------|
| `GET /activeProvider` | Active provider + providers with keys |
| `GET /provider-details` · `POST /provider-details` | Provider detail CRUD helper |
| `GET /safe` | Full config bootstrap for the desktop app |
| `GET/PUT /model-aliases` | Model alias list |
| `GET/PUT /subagent-fallback` · `POST …/test` | Sub-agent fallback |
| `GET/PUT /background-review` | Background review LLM |
| `GET/PUT /model-fleet` | Cognitive model fleet |
| `GET/PUT /model-params` | Per-model wire capability families (`modelParams.families`; the PUT validates every entry) |
| `GET /model-params/resolve?modelId=` | Which family answers for a model id and what it permits on the wire |
| `GET/PUT /cognitive` | Cognitive config tree |
| `GET/PUT /session-export` | JSON session export toggle / status |
| `GET/PUT /live` | Live / speech config |
| `GET/PUT /web` | Web search / extract config (`auxiliary.web` backends + compress thresholds) |
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
| `POST /api/providers/{id}/models` · `PATCH/DELETE …/models/{modelId}` | Model add / edit / delete |
| `GET /api/providers/{id}/models` | List stored models for a provider |
| `POST /api/providers/{id}/discover` | Probe live `/models` endpoint (read-only — store not mutated) |
| `POST /api/providers/{id}/models/{modelId}/test` | Probe a model (accepts any non-empty reply as success) |
| `GET /api/providers/quota` | Per-model quota rows — provider-native when observed, local otherwise |

#### `GET /api/providers/quota`

| Query | Response |
|-------|----------|
| *(none)* | `{results: [{provider, quotas: ModelQuota[]}]}` |
| `?provider=X` | `{results: ModelQuota[]}` |
| `?provider=X&model=Y` | one `ModelQuota` |
| `range=7d` \| `30d` (default) | local usage window |

`ModelQuota`:

| Field | Meaning |
|-------|---------|
| `used` / `prompt` / `completion` | August's own token spend in the window (from `/api/usage` events) |
| `limit` | Provider-stated cap, or `null`. Never inferred — a provider that published no cap keeps `null` |
| `remaining` | Provider-stated remaining budget (native rows) |
| `nativeUsed` | `limit − remaining` — the **provider's** consumption over **its** window, kept separate from `used` |
| `percent` | `nativeUsed / limit × 100`, rounded; `0` when there is no limit |
| `resetsAt` / `observedAt` | ISO-8601 reset time / when the reading was taken |
| `source` | `native` when the provider stated a real limit, otherwise `local` |

A native row appears only when a limit was actually observed — from standard
`x-ratelimit-*` response headers captured into a bounded in-process store
(1 h TTL) or from the provider's opt-in `quotaEndpoint` (see
[CONFIGURATION.md](CONFIGURATION.md#dataprovidersjson)). Any endpoint failure
leaves the row `local`; the read never fails because of optional enrichment.

`PATCH /api/providers/{id}` accepts `quotaEndpoint` and `quotaAuth` (both
nullable; an object declares one, `null` clears it). `quotaEndpoint.kind` is
typed and only `json` is accepted — anything else is a `422` rather than a
silent never-call. `quotaAuth.token` is write-only: responses carry
`tokenSet`/`tokenMasked`.

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

### `/api/sessions`

Separate session store API (list/create/get/patch/delete/messages) used by some
desktop paths alongside workbench sessions.

| Method & path | Purpose |
|---------------|---------|
| `GET /api/sessions` | List stored sessions (camelCase rows, incl. `isArchived`) |
| `POST /api/sessions` | Create an empty session row |
| `GET /api/sessions/{id}` | One session |
| `PATCH /api/sessions/{id}` | `{ isArchived: bool }` — archive / restore; absent fields stay untouched, unknown id → 404 |
| `DELETE /api/sessions/{id}` | Cascade-delete the session, its messages and timeline |
| `GET /api/sessions/{id}/messages` | Transcript (`limit` / `offset` paging) |
| `POST /api/sessions/{id}/messages` | Append `{ role, content }` |
| `GET /api/sessions/search?q=` | FTS5 search across message content |

---

## Memory & brain

### `/api/brain`

Served entirely by `routers/brain_config.py`. There is no `/api/memory` API and
no `routers/memory.py`: the old memory routes (`/memory/auto`, `/memory/review`)
and the deleted `brain` / `brain_dashboard` routers (`/status`, `/vectors`,
`/graph`, `/guidelines`, `/events`, `/harness/evals`, `/health`,
`/delta-consent`, `/backfill-workbench`) answer nothing. `remember`,
`list_facts` and `forget` are agent **tools**, not HTTP endpoints.

Reads return rows in a camelCase wire shape, but `PATCH` keys are validated
against the store's **snake_case column names** — send `fact_value`, not
`factValue`. A key that is not a real column is ignored, and a patch of nothing
but ignored keys is a `400`, not a silent no-op.

| Area | Method & path | Purpose |
|------|---------------|---------|
| Config | `GET /config` · `PUT /config` | Effective brain config + defaults + source tag; partial update |
| | `POST /config/reset` · `GET /config/from-session?sessionId=` | Restore defaults; read the config one session used |
| Browse | `GET /stores` | Store summary (name, label, row count) |
| | `GET /stores/{name}?limit&offset&query&sort&category&source&confidence` | Paginated rows (`limit` ≤ 200); filters are server-side so they hold past the cap |
| Edit | `PATCH /stores/{name}/{row_id}` | Whitelisted columns only. `facts`: `fact_value, title, kind, description, category, confidence, expires_at`; `memory`: `value`; `timeline`: `event_summary, category`. `heuristics` → 403 |
| | `DELETE /stores/{name}/{row_id}` | Remove one row (unknown id → 404) |
| Profile lane | `PATCH /stores/facts/{id}` `{ "kind": "profile" }` | `kind='profile'` facts ride into **every** turn's context regardless of `memoryAutoInject`; set `kind` back to `fact` to retire one. Drops the cached recall index so it takes effect at once |
| Consolidation | `GET /consolidation/log` · `POST /consolidation/run` | M4 pass log + M5 lesson-promotion decisions; run one pass now |
| Telemetry | `GET /turn-outcomes?days=` | Per-model/provider error rates + the turn verdict distribution. Diagnostics only — never injected into prompts |
| | `GET /memory/metrics?days=` | Recall and latency metrics |
| | `GET /memory/preview?query&workspace` | The **verbatim** text a turn receives: the `<memory>` block, the session-start memory index, and the project boot block. Rendered by the same builders the workbench calls, so Settings → Memory cannot disagree with chat. `autoInject` / `modelMemoryRead` come back too — the UI says which gate shaped the block |
| Routing | `POST /routing/arena` · `GET /routing/arena` · `GET /routing/suggestions` | Record an Arena/Debate verdict, read the archive, rank models by win rate. There is no automatic per-turn rerouting |
| Raw state | `GET /state-lookup?key=` | One `internal_state` / `memory_store` row by key |
| Memory files | `GET /integrity` | `PRAGMA integrity_check` on the live DB, its path, healthy-copy count and any staged restore |
| | `GET /backups` | Every copy, each with its own verdict, plus `keep`, `pendingRestore` and the folder |
| | `POST /backups` `{reason}` | Take a verified copy now → `{ name, bytes, appliedVersion, pruned }` |
| | `POST /backups/restore` `{name}` | Verify and stage a restore (see below) |
| | `DELETE /backups/restore` | Cancel a staged restore |

### Memory files: verify, back up, restore

`app/services/brain_backup.py`. The brain database *is* the user's memory, so a
copy is checked with `PRAGMA integrity_check` **and must actually hold pages and
brain tables** before anything is allowed to trust it — a zero-byte file is a
well-formed SQLite image that `integrity_check` answers `ok` for. After that
gate, only the newest **5** copies survive retention. `POST /backups` copies
through SQLite's backup API on a read-only handle, so the live file is never
write-locked; the app also takes one verified copy per 12 h at startup.

A restore is **staged, never applied in place**: the running process holds the
database open on more than one thread, so swapping the file underneath it yields
a half-old database. `POST /backups/restore` verifies the copy and writes
`backups/brain-restore.pending`; `main.py` performs the swap before the memory
store initializes, and keeps the database it replaced as `<db>.pre-restore`. The
response says `appliesOn: "next-launch"` for that reason — restart August to
apply, or `DELETE /backups/restore` to abandon it.

A copy is refused as a restore target when it fails `integrity_check`, when it
holds no pages or no `schema_migrations`/`facts` table (an empty copy restores
as an amnesic database), or when its schema version is newer than this build
knows (so an older app cannot boot a
newer database and report it as up to date). Backup names are matched strictly:
`brain-YYYYMMDDTHHMMSSZ-<reason>.sqlite`, stamp with **no dashes**, e.g.
`brain-20260922T090000Z-legacy.sqlite`. To recover a legacy database file, copy
it into the backups folder under exactly such a name — anything else is not
listed, so it cannot be chosen.

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
| `/api/git/*` | status, log, branches, diff, checkout, commit, command |

---

## Automations, cron, exam, calendar

| Prefix | Purpose |
|--------|---------|
| `/api/automations` | List/create/run/delete automation jobs — a POST carrying an existing `id` updates only the fields in the body |
| `/api/kanban` | The durable agent board (shared by the UI and the `board` tool): list, add, patch/move, delete, clear-done, import |
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

## AUG.md

| Method & path | Purpose |
|---------------|---------|
| `GET /api/aug/context` | Loaded AUG context |
| `POST /api/aug/init` | Generate / refine AUG.md |
| `PUT/DELETE /api/aug/content` | Write / clear content |

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
| `done` | Generation complete | `{sessionId, usage?}` — `usage` is `{inputTokens, outputTokens, contextTokens}` when token tracking is on |
| `keepalive` | Idle | comment line `: keepalive` |

The stream terminates after `done`, `error`, or `aborted`. Pass the last `id`
as `sinceSeq` on reconnect to resume without gaps.
