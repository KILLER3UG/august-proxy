# Architecture

This document describes how August Proxy is structured and how a request
flows from a client through the proxy to an upstream provider and back.

---

## Table of Contents

1. [High-level overview](#high-level-overview)
2. [Request flow](#request-flow)
3. [The proxy layer (`/v1/*`)](#the-proxy-layer-v1)
4. [The workbench](#the-workbench)
5. [Provider resolution](#provider-resolution)
6. [Adapters (Anthropic ↔ OpenAI)](#adapters-anthropic--openai)
7. [Memory & learning subsystem](#memory--learning-subsystem)
8. [Skills & curator](#skills--curator)
9. [Gateway (platform adapters)](#gateway-platform-adapters)
10. [Browser & desktop automation](#browser--desktop-automation)
11. [Live / voice](#live--voice)
12. [MCP & service connections](#mcp--service-connections)
13. [Frontend surfaces](#frontend-surfaces)
14. [Background services & lifecycle](#background-services--lifecycle)
15. [Data persistence](#data-persistence)

---

## High-level overview

```
            ┌─────────────────────────── clients ───────────────────────────┐
            │  Claude Code · Codex · Cline · dashboard · Tauri · bots · Live │
            └───────────────┬───────────────────────────────┬─────────────────┘
                            │ /v1/messages                  │ /api/*
                            │ /v1/chat/completions           │ (dashboard + gateway)
                            ▼                               ▼
                   ┌──────────────────────────────────────────────┐
                   │              FastAPI app (main.py)            │
                   │   lifespan: memory_store · cognitive_boot     │
                   │   · log_stream · gateway · curator · tools    │
                   └──────────┬───────────────────────┬───────────┘
                              │                       │
              ┌───────────────▼─────────┐   ┌─────────▼──────────────────┐
              │   Proxy routers (/v1)   │   │   API routers (/api/*)      │
              │   proxy · models        │   │ workbench · config · brain  │
              └───────────────┬─────────┘   │ live · mcp · terminal · …   │
                              │             └──────────┬───────────────────┘
                              ▼                        │
                   ┌──────────────────────┐            │
                   │   adapters/          │◄───────────┘  (workbench reuses adapter
                   │   anthropic · openai  │              translation + clients)
                   │   proxy_tools         │
                   └──────────┬────────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │  providers/clients/   │  HTTP transport + SSE + retry
                   │  base · openai ·      │
                   │  anthropic · gemini … │
                   └──────────┬────────────┘
                              │
                              ▼
                   ┌──────────────────────────────┐
                   │  upstream provider APIs        │
                   │  Anthropic · OpenAI · custom   │
                   │  OpenAI-compatible gateways    │
                   └──────────────────────────────┘
```

The server is a single FastAPI process ([`app/main.py`](../backend-py/app/main.py)).
On startup its `lifespan` reloads settings, starts the log-stream hub, registers
tools, initialises the memory store / brain SQLite, boots cognitive services
(db_writer, consolidation, cron/scheduler, daemons), starts the gateway runner,
and prepares the skill curator + subagent orchestrator. On shutdown it tears
those down and closes browser sessions.

---

## Request flow

There are two distinct request families, served from the same port (default `8085`):

### 1. Proxy requests (`/v1/*`)

Used by external clients (Claude Code, Codex, Cline). These are pure
passthrough/translation requests — no workbench session object is required
(optional AUG.md injection can be enabled for proxy path).

1. Client sends `POST /v1/messages` (Anthropic) or `POST /v1/chat/completions` /
   `POST /v1/responses` (OpenAI).
2. The relevant adapter ([`adapters/anthropic.py`](../backend-py/app/adapters/anthropic.py)
   or [`adapters/openai.py`](../backend-py/app/adapters/openai.py)) resolves the
   model alias, the provider, and the API key.
3. If the upstream format differs from the client format, messages, system
   blocks, and tool definitions are translated.
4. The request is sent upstream via a provider client
   ([`providers/clients/`](../backend-py/app/providers/clients/)).
5. The response (streaming or non-streaming) is translated back to the client's
   format. Managed proxy tools (web search, web fetch, bash, etc.) are
   intercepted and executed locally in a multi-round loop via the tool registry.

### 2. Dashboard / API requests (`/api/*`)

Used by the React/Tauri dashboard, mobile companion, and platform gateways.
These drive the workbench, manage config, query brain state, and stream
telemetry. Most routes are JSON; workbench chat and several monitor/brain
endpoints use SSE; log stream uses WebSocket.

---

## The proxy layer (`/v1/*`)

| Endpoint | Handler | Purpose |
|----------|---------|---------|
| `POST /v1/messages` | `adapters.anthropic` via `routers.proxy` | Anthropic Messages API |
| `POST /v1/chat/completions` | `adapters.openai` via `routers.proxy` | OpenAI Chat Completions |
| `POST /v1/responses` | `adapters.openai` via `routers.proxy` | OpenAI Responses-style SSE synthesis |
| `GET /v1/models` | `routers.proxy` / `routers.models` | Model catalog (providers + aliases) |

Token counting may be available depending on adapter paths; prefer `/v1/models`
and workbench capabilities for operator tooling.

The Anthropic adapter handles model alias resolution, system-prompt
normalization (August reminder; optional AUG.md on proxy when enabled), tool
definition canonicalization, message translation, multi-round managed-tool
resolution, and SSE conversion.

---

## The workbench

The workbench ([`services/workbench/`](../backend-py/app/services/workbench/))
is the agentic chat engine. It maintains sessions, runs a multi-round tool loop,
and emits SSE events.

### Session lifecycle

- `WorkbenchSession` is an in-memory dataclass.
- **Source of truth:** SQLite `sessions` / workbench blob + `messages` tables in
  `data/august_brain.sqlite` via `memory_store.save_workbench_session_sot`.
- **JSON export is optional** (`auxiliary.session_json_export` or
  `AUGUST_SESSION_JSON_EXPORT=1`). When enabled, a backup is written to
  `data/workbench-sessions.json`. Older installs one-shot migrate JSON → SQLite.
- In-memory cache keeps the **last 50** sessions by `updatedAt`.
- CRUD and chat APIs live under `/api/workbench/*` (also singular `/session`
  aliases). Related: checkpoints, agent binding, guard mode, todos, plan
  approve/reject, mutations, worktree, compact, undo, queue/steer, doctor,
  skills hub, Python sandbox.

### The streaming chat loop

`send_workbench_message_stream()` is the primary entry point:

1. Get-or-create the session; append the user message.
2. Resolve effort (low/medium/high/max) and provider/model.
3. Optionally compress context if estimated tokens exceed half the budget.
4. Enter the **tool loop** (unlimited by default when
   `MAX_MANAGED_TOOL_ROUNDS = 0`):
   - Stream `thinking` / `final_output` / tool events.
   - Execute tools through the registry (parallel for read-only allowlist).
5. Persist conversation + token usage to SQLite.
6. Fire-and-forget: background review, auto-memory, self-evolution, brain sync.

### Guard modes

| Mode | Behaviour |
|------|-----------|
| `full` | All tools allowed (default) |
| `plan` | Destructive tools blocked until a plan is approved; `submit_plan` proposes one |
| `ask` | Destructive tools return an approval-required message to the model |

Plan submission / approve / reject is never itself blocked as a “destructive”
mutation of the plan gate.

### Sub-agents

[`services/workbench/subagent.py`](../backend-py/app/services/workbench/subagent.py)
plus [`subagent_orchestrator.py`](../backend-py/app/services/subagent_orchestrator.py)
and HTTP `/api/subagents/*`. Sub-agents resolve inherited model aliases, apply
`subAgentFallback`, enforce depth caps, and reuse workbench model callers.

### Event log

[`services/event_log.py`](../backend-py/app/services/event_log.py) is a
per-session ring buffer (in-memory + fan-out). Subscribers register a queue
**before** replaying past events. Keepalives prevent idle SSE disconnects.

---

## Provider resolution

Providers are **user-configured data** only (no built-in template catalog):

| Source | Role |
|--------|------|
| `data/providers.json` | User-configured providers (name, base URL, API format, key, models) |
| `data/config.json` | Aliases, active provider, auxiliary settings |

- [`resolver.py`](../backend-py/app/providers/resolver.py) resolves only from `providers.json`.
- [`model_resolver.py`](../backend-py/app/providers/model_resolver.py) resolves
  model id or alias → `{provider, model, is_fallback}`.
- [`route_resolver.py`](../backend-py/app/providers/route_resolver.py) finds a
  provider for a given model.

Clients under [`providers/clients/`](../backend-py/app/providers/clients/) wrap
`httpx.AsyncClient` with shared SSE parsing, retry-with-backoff on 429/503,
auth-header building, and token estimation. Bespoke clients exist for
Anthropic, OpenAI, Gemini, MiniMax, Bedrock, plus the shared base.

---

## Adapters (Anthropic ↔ OpenAI)

[`adapters/anthropic.py`](../backend-py/app/adapters/anthropic.py) and
[`adapters/openai.py`](../backend-py/app/adapters/openai.py) contain:

- **Model alias resolution**
- **System prompt building** — normalize blocks, inject August reminder
- **Message translation** — Anthropic ↔ OpenAI, including tool grouping and
  signature-safe thinking blocks
- **SSE streaming** — native and converted streams
- **Managed tool resolution** — multi-round loop for proxy-managed tools

[`adapters/proxy_tools.py`](../backend-py/app/adapters/proxy_tools.py)
canonicalizes tool definitions, classifies managed vs client-owned tools, and
executes managed tools **through the real tool registry** (no stub success
strings).

---

## Memory & learning subsystem

[`services/memory/`](../backend-py/app/services/memory/) is a layered memory
system backed by `data/august_brain.sqlite` (via
[`services/memory_store/`](../backend-py/app/services/memory_store/) and
[`memory_conn.py`](../backend-py/app/services/memory_conn.py)):

| Module | Role |
|--------|------|
| `context_builder.py` | Assembles system prompt from memory + agent + tools |
| `context_compressor.py` | Summarizes the middle of a long conversation |
| `auto_memory.py` | Fire-and-forget extraction; vector + graph planes when enabled |
| `background_review.py` | Interval-gated LLM review → skills + facts |
| `self_evolution.py` | Lightweight regex reflection (corrections, preferences) |
| `graph_memory.py` / `knowledge_tree.py` / `topic_index.py` | Structured indexes |
| `vector_db.py` | Cosine similarity over embeddings in SQLite |
| `memory_curator.py` / `memory_quality.py` / `memory_retention.py` | Governance |
| `brain_orchestrator.py` | Cognitive orchestration settings/runtime |
| `brain_write_facade.py` | Transactional multi-table brain writes |

HTTP: `/api/memory/*`, `/api/brain/*` (dashboard, config, activity, heuristics,
consolidation), plus workbench brain sync.

### Unified connectivity (session / config / cognitive SoT)

| Concern | Source of truth | Notes |
|---------|-----------------|--------|
| Chat sessions | SQLite workbench blob + messages | JSON backup optional |
| Model fleet | `model_fleet_service` → `auxiliary.cognitive.fleet` | Settings without restart |
| Cognitive config | `auxiliary.cognitive.{boot,features,fleet,orchestrator}` | Shared tree |
| Vector / graph | SQLite tables in `august_brain.sqlite` | Legacy JSON import if tables empty |
| Consolidation | Cognitive scheduler mutex | Last run in memory kv |
| Proxy managed tools | `tool_registry` via `proxy_tools` | Real dispatch only |
| Live speech | Browser Web Speech by default; optional server STT/TTS | Unconfigured → honest 501 |
| MCP | `mcp-servers.json` at boot | stdio + SSE + streamable HTTP |
| Host / desktop | Local desktop automation or `AUGUST_HOST_AGENT_URL` | Health under monitoring / desktop-automation |

### Brain write classes

| Class | Path | When |
|-------|------|------|
| **Hot path / SoT** | Direct `memory_store` txn | User-facing session/history |
| **Must-succeed queue** | `db_writer.enqueue_write(..., must_succeed=True)` | Never age-dropped; FIFO |
| **Best-effort queue** | `db_writer` low priority | May age-drop |
| **Facade multi-table** | `brain_write_facade` | Transactional multi-table |

Reads always bypass the writer queue (WAL).

---

## Skills & curator

Skills are markdown directories (`SKILL.md` + optional support files) from:

- Bundled: repo `skills/`
- Agent-authored: `data/skills/`

[`services/skill_service.py`](../backend-py/app/services/skill_service.py)
handles discovery, authoring, copy-on-write patch of bundled skills, and delete.

[`services/skills/curator.py`](../backend-py/app/services/skills/curator.py)
manages agent-authored lifecycle: usage sidecar, `active → stale → archived`,
physical move into `.archive/`, pin exemption, hourly background loop.

HTTP: `/api/skills/*`, `/api/curator/*`.

---

## Gateway (platform adapters)

[`services/gateway/`](../backend-py/app/services/gateway/) exposes the workbench
agent over chat platforms.

- **Two-guard concurrency:** one in-flight turn per session (queue extras);
  control commands (`/stop`, `/new`, `/reset`, `/approve`, `/deny`, `/status`)
  bypass the queue and cancel first.
- Platforms: Telegram (webhook + long-poll), Slack (Socket Mode), Discord
  (optional `discord.py` — adapter skipped if SDK missing).
- HTTP: `POST /api/gateway/telegram/webhook`, `GET /api/gateway/status`.
- Config: `config.json → gateway` + bot token env vars.

---

## Browser & desktop automation

### Browser (Playwright)

[`services/browser/`](../backend-py/app/services/browser/) — per-workbench-session
isolated browser context/page: open, click, type, select, scroll, wait,
screenshot, evaluate, get_content. URL allowlist; screenshots on disk.
HTTP: `GET /api/browser/screenshot`.

### Desktop automation / host agent

[`services/desktop_automation.py`](../backend-py/app/services/desktop_automation.py)
and [`routers/desktop_automation.py`](../backend-py/app/routers/desktop_automation.py)
— health, config, action dispatch. Related security / computer-use settings and
observation gallery live under security/observability APIs.

---

## Live / voice

[`routers/live.py`](../backend-py/app/routers/live.py) +
[`services/live_speech.py`](../backend-py/app/services/live_speech.py):

| Path | Purpose |
|------|---------|
| `POST /api/live/session` | Open a live session |
| `POST /api/live/turn` | Process a turn |
| `POST /api/live/stt` / `stt/upload` | Server speech-to-text (optional provider) |
| `POST /api/live/tts` | Server text-to-speech (optional) |

Product default for speech is **browser** Web Speech / `speechSynthesis`.
Server STT/TTS requires a configured OpenAI-compatible speech provider; otherwise
endpoints return honest **501**. Live config: `GET/PUT /api/config/live`.

---

## MCP & service connections

- **MCP** — [`services/tools/mcp_client.py`](../backend-py/app/services/tools/mcp_client.py),
  config in `data/mcp-servers.json`, HTTP `/api/mcp/*` (servers, directory,
  tools, start/stop). Tools are refreshed at boot.
- **Service connections** — GitHub, Slack, Google OAuth under
  `/api/service-connections/*`; MCP env under `/api/mcp-env`. Google OAuth env
  keys are mirrored into durable `mcpGlobalEnv` at startup.

---

## Frontend surfaces

| Path | Stack | Role |
|------|-------|------|
| `frontend/desktop/` | React 19 + Vite + Tauri 2 | Main product UI |
| `frontend/mobile/` | Expo | Companion app |
| `web-dist/` | Build output | Served by FastAPI as SPA |

Major desktop section areas (sidebar/registry-driven): chat/workbench, brain,
live, providers/models, MCP/connections, agents, automations, exam, terminal,
memory, traffic/inspector, settings (system health, computer use, API access,
backend monitor, feature flow, plans, skills, …).

Settings IA is documented in [`settings-audit.md`](settings-audit.md).

---

## Background services & lifecycle

Started in [`main.py`](../backend-py/app/main.py) `lifespan` (each block
try/except so one failure does not block boot):

| Service | Startup | Shutdown |
|---------|---------|----------|
| Settings + Google OAuth → mcpGlobalEnv | reload + mirror | — |
| Log-stream hub (`log_stream`) | `startHub` + WS log handler | `stopHub` |
| Tool registry | `tool_definitions.registerAll` | — |
| Memory store | `memory_store.init` + optional storage-key migration | close paths in cognitive stop |
| MCP tools | `refreshMcpTools` task | — |
| Cognitive boot | db_writer, consolidation, cron/scheduler, daemons | `stop_cognitive_services` |
| Gateway runner | `startGateway` | `stop` |
| Curator + subagent orchestrator | `get_curator` / `get_orchestrator` | `shutdown_runtime_services` |
| Browser pool | lazy | `closeAll` |
| Daemon manager | via cognitive / runtime | `shutdownAll` |

---

## Data persistence

### Primary store

**One SQLite database:** `data/august_brain.sqlite` (WAL) — sessions, messages,
memory planes, audit, kv, graph/vector tables, etc.

Brain schema identifiers are **snake_case** (tables/columns); HTTP/JSON wire
stays **camelCase** via `memory_store` wire helpers.

### JSON / side files

| Path | Contents |
|------|----------|
| `config.json` | Keys, aliases, cognitive/auxiliary, gateway, security |
| `providers.json` | User providers |
| `mcp-servers.json` | MCP server definitions |
| `request-log.json` | Request inspector log |
| `workbench-sessions.json` | **Optional** session backup export (not SoT) |
| `august_graph_memory.json` | Legacy graph import source (if present) |
| `skills/` | Agent-authored skills + usage + archive |
| `browser_screenshots/` / observations | Screenshots |

> **Removed / no longer used as SoT:** separate `august-sessions.db`,
> `august_core_memory.json`, `august_semantic_memory.json`,
> `august_infinite_memory.json`. Memory and sessions live in the brain SQLite.

Paths resolve through [`app/lib/paths.py`](../backend-py/app/lib/paths.py)
(`dataPath`, respects `AUGUST_DATA_DIR`).

### SQLite — single-writer async queue

[`memory_conn.py`](../backend-py/app/services/memory_conn.py): WAL,
`busy_timeout=10000`, `foreign_keys=ON`.

[`db_writer.py`](../backend-py/app/services/db_writer.py): one worker, **FIFO**
shared queue; low-priority items age-dropped at dequeue; high priority does
**not** jump the queue. Primary production caller: consolidation daemon. Do not
design new hot-path features as if `priority=` were a latency scheduler.

### JSON stores — atomic writes

Use [`app/atomic_write.py::write_json_atomic`](../backend-py/app/atomic_write.py)
(temp file + fsync + `os.replace`). Skill curator uses temp + `Path.replace`.

### Brain DB verification tooling

| Script | Purpose |
|--------|---------|
| `backend-py/scripts/_live_db_fingerprint.py` | Table counts + content hashes |
| `backend-py/scripts/_verify_fts_sync.py` | FTS coverage (SQL-level) |
| `backend-py/scripts/_check_fts_query_hygiene.py` | Static FTS anti-pattern scan |
| `backend-py/scripts/_spotcheck_schema.py` | Schema inventory |
| `backend-py/scripts/p0_explain_plans.py` | EXPLAIN QUERY PLAN pack |

**Tests must not touch the live brain.** `tests/conftest.py` makes `isolatedData`
**autouse** (temp `AUGUST_DATA_DIR` + brain SQLite). Do not remove without a
safety review.

### Runtime kill switches / measurement flags

| Env / flag | Effect |
|---|---|
| `AUGUST_PERF_TIMING=1` | Backend workbench span/TTFT logging + ring buffer |
| `AUGUST_P1_TOOL_CACHE=0` | Disable tool-definition list cache |
| `AUGUST_P1_PROMPT_CACHE=0` | Disable skills/prompt-segment cache |
| `AUGUST_P1_PARALLEL_TOOLS=0` | Force serial tool execution |
| `AUGUST_SESSION_JSON_EXPORT=1` | Enable continuous JSON session backup |
| `localStorage.august_stream_perf=1` | Frontend stream TTFT/flush marks |
