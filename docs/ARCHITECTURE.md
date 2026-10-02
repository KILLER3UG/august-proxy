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
            │  Claude Code · Codex · Cline · Tauri desktop · bots · Live │
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
(consolidation, cron/scheduler, daemons), starts the gateway runner,
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
  skills hub, Python sandbox, agent mode (`chat`/`agent`/`code`/`orchestrator`),
  workstreams / episodes, harness jobs.

### The streaming chat loop

`sendWorkbenchMessageStream()`
([`services/workbench/workbench.py`](../backend-py/app/services/workbench/workbench.py))
is the primary entry point:

1. Get-or-create the session; append the user message.
2. Resolve effort (low/medium/high/max) and provider/model.
3. Optionally compress context if estimated tokens exceed half the budget.
4. Enter the **tool loop** (default cap `0 = uncapped`, overridable via the
   Brain setting `maxWorkbenchToolLoops`):
   - Stream `thinking` / `finalOutput` / `toolCall` / `toolResult` events. Wire
     names are **camelCase** — import them from
     [`workbench/emit_types.py`](../backend-py/app/services/workbench/emit_types.py)
     instead of spelling them. The snake_case `final_output` is accepted for legacy
     readers and must never be emitted.
   - Execute tools through the registry (parallel for read-only allowlist).
5. Persist conversation + token usage to SQLite.
6. Fire-and-forget: background review, auto-memory, self-evolution, brain sync.
   There is no user-facing memory-review step any more — `POST /api/memory/review`
   and `routers/memory.py` were removed with the feature. Every turn closes with a
   `turn_end {reason, rounds, error}` event
   (`finished | length | cap | stall-stop | budget | error | interrupted |
   awaiting-input`); read that before auditing code for "why did it stop". Each
   mid-flight rescue emits a `recovery {kind, attempt, outcome, degraded}` frame
   first, and `degraded: true` is the trust signal that the answer shipped
   truncated or on a reduced tool surface.

**Orchestrator / harness:** when `agent_mode` is `orchestrator`, the loop
exposes Plan → Dispatch, named workstreams, and a spawn DAG. Sub-agent SSE
includes `skills`. Continue dirty uses the last named workstream + episodes
(`GET /api/subagents/workstreams/{name}/episodes`). Worker lanes in the
desktop UI open the right-drawer `subagents` section.

**Agent modes:** `set_agent_mode` / `POST /api/workbench/agent-mode` —
`chat` blocks tools, `agent` is native tool calling, `code` runs a fenced
Python block through sandboxed `run_command`.

**Verifier:** REMOVED (2026-08-24) — the old per-session `verifierEnforced`
gate that withheld `finalOutput` no longer exists; answers stream directly.

### Guard modes

| Mode | Behaviour |
|------|-----------|
| `full` | All tools allowed (default) |
| `plan` | Destructive tools blocked until a plan is approved; `submit_plan` proposes one |
| `ask` | Destructive tools return an approval-required message to the model |

Plan submission / approve / reject is never itself blocked as a “destructive”
mutation of the plan gate.

### Execution state

Alongside guard modes, the workbench tracks a multi-phase **execution state**
per session via the `update_state` system tool (`tool_registrations/system_tools.py`):

| Phase | Meaning |
|-------|---------|
| `research` | Gathering context (default) |
| `plan` | Drafting an approach |
| `implement` | Making changes |
| `review` | Verifying the change |
| `complete` | Done |

State is injected into the next turn's system prompt so the model resumes where
it left off. Receipts (`run_command` / `bash` / `safe_python`) are judged on
transitions into `review` / `complete`. Phase/step changes are emitted as
`executionState` SSE events (the inline working strip shows the current
phase). The former verifier gate / receipts machinery was removed
(2026-08-24); answers are never withheld.

### Sub-agents

[`services/workbench/subagent.py`](../backend-py/app/services/workbench/subagent.py)
plus [`subagent_orchestrator.py`](../backend-py/app/services/subagent_orchestrator.py)
and HTTP `/api/subagents/*`. Sub-agents resolve inherited model aliases, apply
`subAgentFallback`, enforce depth caps, and reuse workbench model callers.
Structured harness: `delegation {maxConcurrent, maxIterations, maxDepth, worktreeIsolation}`
in `workbench.metadata.delegation` (`GET/POST /api/subagents/config`). Statuses `queued/running/stalling`
with `queuePosition/queueTotal`, `lastActivityAt/apiCalls` stall monitor (>90s → `stalling`),
`result_full` 20k blob + `cache/delegation/<taskId>.jsonl` live transcript (`GET /{taskId}/transcript`).
Drawer-only UI: the transcript has no inline sub-agent launch list — the composer
chip is [`HarnessModeChip.tsx`](../frontend/desktop/src/components/chat/HarnessModeChip.tsx)
(modes `chat | agent | code | orchestrator`, `planner` accepted as an alias) with
wave counts from [`harness-wave.ts`](../frontend/desktop/src/components/chat/harness-wave.ts),
the guard-mode control is `SandboxModeSelector.tsx`, and full worker detail lives
in the right-drawer `Subagents` section (queue, live timeline, persisted final).

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
auth-header building, and token estimation. There are exactly three: `anthropic.py`,
`openai.py`, and the shared `base.py` (`rate_gate.py` carries the backoff policy).
There is **no first-class Gemini / MiniMax / Bedrock client** —
[`providers/api_format.py`](../backend-py/app/providers/api_format.py) normalizes
those names onto one of the three wire formats (`gemini`/`bedrock` → `openaiChat`,
`minimax` → `anthropicMessages`), and an unrecognized value falls back to
`openaiChat` with a logged warning.

---

## Adapters (Anthropic ↔ OpenAI)

[`adapters/anthropic.py`](../backend-py/app/adapters/anthropic.py) and
[`adapters/openai.py`](../backend-py/app/adapters/openai.py) are the two
format translators, but the shared work now lives in dedicated modules beside
them rather than in those two files:

- **Model alias resolution** and **message translation** (Anthropic ↔ OpenAI,
  including tool grouping and signature-safe thinking blocks) stay in the two
  adapter modules.
- **System-prompt normalization** — [`anthropic_system.py`](../backend-py/app/adapters/anthropic_system.py)
- **SSE streaming** — [`sse_format.py`](../backend-py/app/adapters/sse_format.py)
  for framing, [`anthropic_sse.py`](../backend-py/app/adapters/anthropic_sse.py)
  and [`openai_sse.py`](../backend-py/app/adapters/openai_sse.py) per format, and
  [`stream_state.py`](../backend-py/app/adapters/stream_state.py) for incremental
  tool-call argument accumulation (`AnthropicNativeStreamState`)
- **Reasoning / thinking policy** — [`reasoning_policy.py`](../backend-py/app/adapters/reasoning_policy.py)
- **Managed vs client-owned tool classification** —
  [`tool_classification.py`](../backend-py/app/adapters/tool_classification.py),
  with definitions in [`proxy_tool_defs.py`](../backend-py/app/adapters/proxy_tool_defs.py)
- **Key casing across the boundary** — [`case_converters.py`](../backend-py/app/adapters/case_converters.py)
- **Upstream failure mapping** — [`upstream_errors.py`](../backend-py/app/adapters/upstream_errors.py)

Upstream request bodies must go through `dump_openai_upstream_body` /
`dump_anthropic_upstream_body` (`exclude_none` + strip August-only keys) —
sending `session_id: null` breaks strict OpenAI-compatible gateways.

[`adapters/proxy_tools.py`](../backend-py/app/adapters/proxy_tools.py)
canonicalizes tool definitions, classifies managed vs client-owned tools, and
executes managed tools **through the real tool registry** (no stub success
strings).

---

## Memory & learning subsystem

[`services/memory_store/`](../backend-py/app/services/memory_store/) is a layered
memory system backed by `data/august_brain.sqlite`. It is a **package of domain
modules**, not one file:

| Module | Role |
|--------|------|
| [`memory_conn.py`](../backend-py/app/services/memory_conn.py) | Thread-local connection, PRAGMA defaults, path resolution |
| [`memory_schema.py`](../backend-py/app/services/memory_schema.py) | Table / FTS / trigger / index DDL |
| `memory_store/sessions.py` · `messages.py` · `transcript_blocks.py` | Workbench sessions, messages (hot path for chat open / pagination), durable block timelines |
| `memory_store/rest.py` | Facts, proposals, lifecycle, topics, usage, timeline, stats |
| `memory_store/brain.py` | `brain_query` multi-store FTS/SQL domain (and the store PATCH whitelist) |
| `memory_store/kv.py` | Key-value memory blob + FTS search |
| `memory_store/fact_retrieval.py` | BM25 recall, the injected `<memory>` tail, the per-session boot index, `memory_context_preview` |
| `memory_store/consolidation.py` | One scheduled consolidation job: expiry, episodic/usage sweeps, duplicate merge, contradiction supersede, retire proposals, skill-learning pass |
| `memory_store/wire.py` | snake_case rows → camelCase wire |
| [`workbench/prompt_build.py`](../backend-py/app/services/workbench/prompt_build.py) (+ `prompt_segments_cache.py`, `prompt_variants.py`) | Assembles the system prompt from memory + agent + tools |
| [`workbench/context_compressor.py`](../backend-py/app/services/workbench/context_compressor.py) | Summarizes the middle of a long conversation |
| [`background_review_service.py`](../backend-py/app/services/background_review_service.py) | Interval-gated LLM review → skills + facts |
| [`brain_config_service.py`](../backend-py/app/services/brain_config_service.py) | brain-config defaults and the snake→camel key mapping |
| [`brain_backup.py`](../backend-py/app/services/brain_backup.py) | Online copies via the SQLite backup API, `integrity_check` before trusting a copy, rolling retention, restore staged for next launch |

HTTP: all brain/memory routes are served by
[`routers/brain_config.py`](../backend-py/app/routers/brain_config.py) under
`/api/brain/*` — `config`, `stores` + `stores/{name}` + `stores/{name}/{id}`,
`consolidation/log` + `consolidation/run`, `turn-outcomes`, `memory/metrics` +
`memory/preview`, `backups` + `backups/restore`, `integrity`, `state-lookup`,
`routing/arena` + `routing/suggestions`, `skills/suggestions`. **There is no
`/api/memory/*` router** — the old `/api/memory/review` + `/review/apply` pair was
removed along with `routers/memory.py`.

Model-managed memory is a **tool set, not an API**: `remember`, `list_facts` and
`forget` are core tools (in `AUGUST_CORE_TOOLS` and `_BARE_TOOL_ALLOW`), so they
survive progressive disclosure and a downgraded model can still correct what it
remembers. Sub-agents read and recall but never write; the parent turn is the
single memory write door.

Desktop **Settings → Memory** (`memory-knowledge`, with `memory-facts` as a hidden
child) renders one flat chronological list across kinds with filter chips — not
tabs, not cards or meters. There is **no** "Memory files" card: the 0.18 restyle
removed the backup / integrity / restore / raw-state surface, so a restore is
staged only through `POST /api/brain/backups/restore`
(`api/api-client/brain-backup.ts` is the surviving client if it is ever rebuilt).

> There is no separate Brain Orchestrator settings tab — controls live in the
> session sidebar. `brain_orchestrator.py` is **gone**; its config moved to
> `auxiliary.cognitive.orchestrator` and `brain_config_service.py` deletes any
> legacy top-level `brain_orchestrator` key it finds. `/api/brain/config*` remain.

### Unified connectivity (session / config / cognitive SoT)

| Concern | Source of truth | Notes |
|---------|-----------------|--------|
| Chat sessions | SQLite workbench blob + messages | JSON backup optional |
| Model fleet | `model_fleet_service` → `auxiliary.cognitive.fleet` | Settings without restart |
| Cognitive config | `auxiliary.cognitive.{boot,features,fleet,orchestrator}` | Shared tree |
| Recall ranking | BM25 / FTS over the brain SQLite | **No vector store and no embedding model** — `fact_retrieval.py`, `tools/retrieval.py` and `text_similarity.py` each state this. Do not add one without deleting the contrary comments |
| Consolidation | Cognitive scheduler mutex | Last run in memory kv (`consolidation:last_run`) |
| Proxy managed tools | `tool_registry` via `proxy_tools` | Real dispatch only |
| Live speech | Browser Web Speech by default; optional server STT/TTS | Unconfigured → honest 501 |
| MCP | `mcp-servers.json` at boot | stdio + SSE + streamable HTTP |
| Host / desktop | Local desktop automation or `AUGUST_HOST_AGENT_URL` | Health under monitoring / desktop-automation |

### Brain writes

There is **one** write path and one coalescing helper — the old `db_writer`
priority queue and `brain_write_facade` no longer exist (nothing in `app/`
defines `enqueue_write`, `must_succeed`, or a low/high priority class).

| Concern | Mechanism |
|---------|-----------|
| SoT writes | Direct `memory_store` transaction on the thread-local connection |
| Commit coalescing | [`deferred_writes.py`](../backend-py/app/services/deferred_writes.py): `defer_commit(conn, window_s=2.0)` holds the commit up to `_MAX_HOLD_S = 10` and `flush_thread_pending()` drains it. Per-thread, loop-thread aware |
| Deliberate failures | [`best_effort.py`](../backend-py/app/services/best_effort.py): `with best_effort('some.site'):` names every intentional swallow so it is greppable, logs with `exc_info`, and **re-raises** under `AUGUST_STRICT_BEST_EFFORT=1`. Not a queue — a context manager |
| Reads | Direct, on WAL, never through the commit window |

---

## Skills & curator

Skills are markdown directories (`SKILL.md` + optional support files). Roots:

- Bundled: repo `skills/`
- Agent-authored: `data/skills/`, plus per-agent roots from
  `skill_service.botRootFor(agentId)` — `migrate_flat_skills()` folds the older
  flat layout into them.

[`services/skill_service.py`](../backend-py/app/services/skill_service.py)
handles discovery, authoring, copy-on-write patch of bundled skills, and delete.
Usage lives in a sibling sidecar, `<dataDir>/skills/<name>/.usage.json` — never
inside the skill directory, so the install tree stays free of it, and
`skill_delete` / `patchSkill` / the usage counter all key on `SKILL.md` rather
than directory existence.

[`routers/curator.py`](../backend-py/app/routers/curator.py)
manages the agent-authored lifecycle. Status is a **frontmatter flag, not a file
move**: draft / active / superseded / retired (`skill_service.SKILL_STATUSES`), read back through `meta`
because `_parseSkill` nests unrecognized frontmatter. Nothing relocates skills
into a `.archive/` directory. The curator also drives the `refine` proposal set
(`/refine`, `/refine/run`, `/refine/{id}/rollback`) and reports through
`/report`, `/outcomes`, `/episodes`.

A `skill_patch` is destructive in a way that surprises people: `_apply_approved`
rewrites `SKILL.md` frontmatter **wholesale**, so `supersedes`, `origin`,
`learned_from` and `trigger` are read back off the existing file and restated —
losing `trigger` would silently retire the skill from per-turn relevance matching.

HTTP: `/api/skills/*`, `/api/skills/packs`, `/api/curator/*`.

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
| `web-dist/` | Build output | Packaged into Tauri; FastAPI may serve it for backend-only runs |

Major desktop surfaces: chat/workbench (composer island, `SubagentTimeline.tsx`
worker lanes, `AssistantBlockTimeline.tsx`, `CircuitArtifactCard.tsx`, and a
right drawer composed of sections — `RightDrawer.tsx` + `…ArtifactsSection`,
`…BrowserSection`, `…CircuitSection`, `…DiffSection`, `…Subagents`), Live, and
Settings.

Settings is **3 header groups, not 8 hubs**: `basics` (label "Basics"),
`capabilities` ("Agent capabilities"), `data` ("Data and statistics") —
`SETTINGS_CATEGORIES` in
[`settings-registry.ts`](../frontend/desktop/src/settings/settings-registry.ts).
The rail is an inline tree (header → section → optional grandchild), not pill
tabs. Today that is 44 sections (15 `basic`, 1 `advanced`, 28 `hidden`); `tier:
'hidden'` ids are interior views that deep-link into their parent via
`railCanonicalId`. There is **no "Show advanced" toggle** in the rail —
`useSettingsAdvancedPreference.ts` still exists but nothing imports it, so the
`advanced` tier in the registry is vestigial. (`RAIL_CHILDREN` is exported but
**imported by nothing** despite being named in `WorkspaceShell.tsx` comments — do
not treat it as the grandchild mechanism.) `docs/settings-audit.md` describes the
superseded 2026-08-28 IA; the registry is the source of truth.

Settings source of truth: [`settings-registry.ts`](../frontend/desktop/src/settings/settings-registry.ts).
[`settings-audit.md`](settings-audit.md) is a historical IA record.

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
| Cognitive boot | consolidation, cron/scheduler, daemons | `stop_cognitive_services` |
| Gateway runner | `startGateway` | `stop` |
| Subagent orchestrator | `get_orchestrator` | `shutdown_runtime_services` |
| Browser pool | lazy | `closeAll` |
| Daemon manager | via cognitive / runtime | `shutdownAll` |

---

## Data persistence

### Primary store

**One SQLite database:** `data/august_brain.sqlite` (WAL) — sessions, messages,
memory planes, audit, kv, episodes, etc.

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
| `skills/` | Agent-authored skills + `.usage.json` sidecars |
| `browser_screenshots/` / observations | Screenshots |

> **Removed / no longer used as SoT:** separate `august-sessions.db`,
> `august_core_memory.json`, `august_semantic_memory.json`,
> `august_infinite_memory.json`, `august_graph_memory.json` (there is no graph
> store and nothing reads it). Memory and sessions live in the brain SQLite.

Paths resolve through [`app/lib/paths.py`](../backend-py/app/lib/paths.py)
(`dataPath`, respects `AUGUST_DATA_DIR`).

### SQLite — single-writer async queue

[`memory_conn.py`](../backend-py/app/services/memory_conn.py): WAL,
`busy_timeout=10000`, `foreign_keys=ON`.

[`deferred_writes.py`](../backend-py/app/services/deferred_writes.py) is **commit
coalescing, not a write queue**: `defer_commit(conn, window_s=WINDOW_S)` (default
`2.0`, hard cap `_MAX_HOLD_S = 10.0`) defers the COMMIT on a thread-local
connection, and `flush_thread_pending()` / `_flush_owned_entries()` drain it. There
is no worker thread, no FIFO queue, and no `priority=` or age-drop parameter — do
not design anything as if there were.

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
| `AUGUST_P1_PROMPT_CACHE=0` | (removed — never read; Part 25 Phase 7.2) |
| `AUGUST_P1_PARALLEL_TOOLS=0` | Force serial tool execution |
| `AUGUST_SESSION_JSON_EXPORT=1` | Enable continuous JSON session backup |
| `localStorage.august_stream_perf=1` | Frontend stream TTFT/flush marks |
