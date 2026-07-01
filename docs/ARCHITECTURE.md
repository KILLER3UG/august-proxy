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
10. [Browser automation](#browser-automation)
11. [Background services & lifecycle](#background-services--lifecycle)

---

## High-level overview

```
            ┌─────────────────────────── clients ───────────────────────────┐
            │  Claude Code · Codex · Cline · Continue.dev · dashboard · bots │
            └───────────────┬───────────────────────────────┬─────────────────┘
                            │ /v1/messages                  │ /api/*
                            │ /v1/chat/completions           │ (dashboard + gateway webhooks)
                            ▼                               ▼
                   ┌──────────────────────────────────────────────┐
                   │              FastAPI app (main.py)            │
                   │   lifespan: init_db · memory_store · gateway   │
                   │              · curator · browser pool         │
                   └──────────┬───────────────────────┬───────────┘
                              │                       │
              ┌───────────────▼─────────┐   ┌─────────▼──────────────────┐
              │   Proxy routers (/v1)   │   │   API routers (/api/*)      │
              │   proxy.py · models.py   │   │ workbench · config · skills │
              └───────────────┬─────────┘   │ curator · gateway · agents  │
                              │             │ monitoring · memory · manage │
                              ▼             └──────────┬───────────────────┘
                   ┌──────────────────────┐            │
                   │   adapters/          │◄───────────┘  (workbench reuses adapter
                   │   anthropic.py        │              translation + clients)
                   │   openai.py           │
                   │   proxy_tools.py      │
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
                   │  Anthropic · OpenAI · Gemini · │
                   │  OpenRouter · Kilo · …         │
                   └──────────────────────────────┘
```

The server is a single FastAPI process ([`app/main.py`](../backend-py/app/main.py)).
On startup its `lifespan` initialises the database, the memory store, the
gateway runner, the skill curator, and prepares the browser pool; on shutdown
it tears them all down.

---

## Request flow

There are two distinct request families, served from the same port:

### 1. Proxy requests (`/v1/*`)

Used by external clients (Claude Code, Codex, Cline). These are pure
passthrough/translation requests — no persistent session, no workbench loop.

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
   intercepted and executed locally in a multi-round loop.

### 2. Dashboard / API requests (`/api/*`)

Used by the React dashboard and platform gateways. These drive the workbench,
manage config, and query telemetry. They are JSON request/response except the
workbench chat, which streams events over SSE.

---

## The proxy layer (`/v1/*`)

| Endpoint | Handler | Purpose |
|----------|---------|---------|
| `POST /v1/messages` | `adapters.anthropic.handle_messages` | Anthropic Messages API (native or OpenAI-translated upstream) |
| `POST /v1/chat/completions` | `adapters.openai` | OpenAI Chat Completions passthrough |
| `POST /v1/responses` | `adapters.openai` | OpenAI Responses API (synthesised SSE for non-native upstreams) |
| `POST /v1/messages/count_tokens` | `adapters.anthropic.handle_count_tokens` | Lightweight token estimate |
| `GET /v1/models` | `routers.models` | Model catalog (built-in + custom + aliases) |

The Anthropic adapter is the most complex: it handles model alias resolution,
system-prompt normalization (with an August reminder injected), tool definition
canonicalization, message translation, multi-round managed-tool resolution, and
both native Anthropic SSE and OpenAI→Anthropic SSE conversion.

---

## The workbench

The workbench ([`services/workbench/workbench.py`](../backend-py/app/services/workbench/workbench.py))
is the agentic chat engine. Unlike the proxy layer, it maintains persistent
sessions, runs a multi-round tool loop, and emits SSE events.

### Session lifecycle

- `WorkbenchSession` is an in-memory dataclass persisted to
  `data/workbench-sessions.json` (last 50 kept).
- Sessions carry provider/model, agent binding, guard mode, plan state,
  pending mutations, the full message history, and token/cost totals.
- CRUD is exposed at `/api/workbench/sessions*`.

### The streaming chat loop

`send_workbench_message_stream()` is the primary entry point:

1. Get-or-create the session; append the user message.
2. Resolve effort (low/medium/high/max) and provider/model (frontend
   `modelProvider` → model hint → session provider).
3. Optionally compress context if estimated tokens exceed half the budget.
4. Enter the **tool loop** (up to `MAX_MANAGED_TOOL_ROUNDS = 10`):
   - Call the model via `_call_anthropic_workbench` or `_call_openai_workbench`,
     which stream `thinking` / `final_output` / `tool_use` events as tokens arrive.
   - If no tool calls → append the assistant message and finish.
   - Otherwise execute each tool through the registry, append results, and re-call.
5. Persist the complete conversation and record token usage.
6. Fire-and-forget: background review, auto-memory sync, self-evolution.

### Guard modes

| Mode | Behaviour |
|------|-----------|
| `full` | All tools allowed (default) |
| `plan` | Destructive tools blocked until a plan is approved; `submit_plan` proposes one |
| `ask` | Destructive tools return an approval-required message to the model |

Destructiveness is decided by `is_plan_mode_blocked()`, which checks an
explicit set of mutating tool names plus a conservative marker heuristic.
Plan submission (`submit_plan` / `approve_workbench_plan` / `reject_workbench_plan`)
is never itself blocked.

### Sub-agents

[`services/workbench/subagent.py`](../backend-py/app/services/workbench/subagent.py)
runs a created agent autonomously: resolves its inherited model alias, applies
the `subAgentFallback` config, enforces a depth cap, inherits permissions, and
runs a focused tool loop reusing the workbench model callers. Sub-agents can
never spawn further sub-agents.

### Event log

[`services/event_log.py`](../backend-py/app/services/event_log.py) is a
per-session ring buffer (in-memory + fan-out). Subscribers register an
`asyncio.Queue` **before** replaying past events, so events appended during
replay are never dropped. A 30s keepalive prevents idle SSE disconnects.

---

## Provider resolution

Providers are defined in [`app/providers/`](../backend-py/app/providers/).
Each built-in module declares a name, base URL, API mode, env vars, and a
`model_profiles` map (with `supportsThinking` flags). Custom providers come
from `providers.json`.

- [`registry.py`](../backend-py/app/providers/registry.py) holds built-in defs.
- [`resolver.py`](../backend-py/app/providers/resolver.py) resolves by name and
  lists available providers (those with keys).
- [`model_resolver.py`](../backend-py/app/providers/model_resolver.py) resolves
  a model id or alias to `{provider, model, is_fallback}`.
- [`route_resolver.py`](../backend-py/app/providers/route_resolver.py) finds a
  provider for a given model.

Provider clients ([`providers/clients/`](../backend-py/app/providers/clients/))
wrap `httpx.AsyncClient` with shared SSE parsing, retry-with-backoff on 429/503,
auth-header building, and token estimation.

---

## Adapters (Anthropic ↔ OpenAI)

[`adapters/anthropic.py`](../backend-py/app/adapters/anthropic.py) contains:

- **Model alias resolution** — `sonnet`/`opus`/`best` → concrete Claude ids.
- **System prompt building** — normalize blocks, inject the August reminder.
- **Message translation** — `translate_messages` (Anthropic→OpenAI) and
  `translate_messages_to_anthropic` (OpenAI/mixed→Anthropic). The latter
  groups consecutive tool messages and strips signature-less thinking blocks
  before re-sending (Anthropic rejects thinking blocks without a signature).
- **SSE streaming** — native Anthropic SSE, and OpenAI→Anthropic SSE conversion
  (`stream_openai_delta_as_anthropic`).
- **Managed tool resolution** — `resolve_managed_anthropic_tool_uses` runs the
  multi-round loop for proxy-managed tools.

[`adapters/proxy_tools.py`](../backend-py/app/adapters/proxy_tools.py)
canonicalizes tool definitions, classifies tool calls as managed/local vs.
client-owned ([`adapters/tool_classification.py`](../backend-py/app/adapters/tool_classification.py)),
and executes managed proxy tools.

---

## Memory & learning subsystem

[`services/memory/`](../backend-py/app/services/memory/) is a layered memory
system backed by `data/august_brain.sqlite` (via
[`services/memory_store.py`](../backend-py/app/services/memory_store.py)):

| Module | Role |
|--------|------|
| `context_builder.py` | Assembles the system prompt from memory + agent + tools |
| `context_compressor.py` | Summarizes the middle of a long conversation to fit a token budget |
| `auto_memory.py` | Fire-and-forget extraction of todos + conversation summaries |
| `background_review.py` | Interval-gated LLM review that authors skills + saves facts |
| `self_evolution.py` | Lightweight regex reflection every turn (corrections, preferences) |
| `graph_memory.py` / `knowledge_tree.py` / `topic_index.py` | Structured memory indexes |
| `vector_db.py` | Zero-dependency cosine-similarity search over conversation summaries |
| `memory_curator.py` / `memory_quality.py` / `memory_retention.py` | Memory governance |

The background review fires after each turn but only runs the LLM when its
gates pass (`turn_interval=3` or `tool_round_interval=6`). Self-evolution runs
every turn but is pure regex — no LLM call.

---

## Skills & curator

Skills are markdown directories (`SKILL.md` + optional support files) scanned
from two roots: bundled (`skills/`) and agent-authored (`data/skills/`).
[`services/skill_service.py`](../backend-py/app/services/skill_service.py)
handles discovery, authoring (with name/description validation and path-traversal
protection), copy-on-write patching of bundled skills, and deletion.

[`services/skills/curator.py`](../backend-py/app/services/skills/curator.py)
manages agent-authored skill lifecycle:

- Tracks usage in a sidecar `.usage.json` (use/view/patch counts, state, pinned).
- Transitions `active → stale` (14 days idle) and `stale → archived` (60 days),
  physically moving skill dirs into a `.archive/` subdir.
- Never deletes; pinned skills are exempt; only agent-authored skills are touched.
- Runs a background loop every hour.

---

## Gateway (platform adapters)

The gateway ([`services/gateway/`](../backend-py/app/services/gateway/)) exposes
the workbench agent over chat platforms.

- [`base.py`](../backend-py/app/services/gateway/base.py) — `BasePlatformAdapter`
  with a **two-guard concurrency model**:
  1. A second message arriving while a turn is running for the same session is
     *queued*, not run concurrently (one in-flight turn per session).
  2. Control commands (`/stop`, `/new`, `/reset`, `/approve`, `/deny`, `/status`)
     bypass the queue and cancel the running turn first.
- [`session_bridge.py`](../backend-py/app/services/gateway/session_bridge.py) —
  maps a gateway session key (`telegram:12345`) to a workbench session id,
  invokes `send_workbench_message_stream`, and accumulates the reply from
  `final_output` events. The runner, session factory, and delete fn are
  injectable for testing.
- [`runner.py`](../backend-py/app/services/gateway/runner.py) — discovers enabled
  platform adapters from config and starts/stops them.
- Platforms: [`telegram.py`](../backend-py/app/services/gateway/platforms/telegram.py)
  (webhook + long-poll fallback), [`discord.py`](../backend-py/app/services/gateway/platforms/discord.py),
  [`slack.py`](../backend-py/app/services/gateway/platforms/slack.py) (Socket Mode).

---

## Browser automation

[`services/browser/`](../backend-py/app/services/browser/) provides 9 Playwright
tools, one headless browser per workbench session (isolated context/page):

- `session_manager.py` — lazy Playwright import, per-session browser/context/page,
  console-log capture, graceful teardown on shutdown.
- `handlers.py` — `browser_open`, `browser_click`, `browser_type`, `browser_select`,
  `browser_scroll`, `browser_wait`, `browser_screenshot`, `browser_evaluate`,
  `browser_get_content`. Enforces a URL allowlist; screenshots saved to disk.
- `element_resolver.py` / `snapshot.py` — element location by ref/selector/text
  and compact accessibility-tree snapshots.

The active session id is propagated via a `ContextVar`
([`workbench/context.py`](../backend-py/app/services/workbench/context.py)) so
handlers resolve per-session state without changing the dispatch signature.

---

## Background services & lifecycle

Started in [`main.py`](../backend-py/app/main.py) `lifespan`:

| Service | Startup | Shutdown |
|---------|---------|----------|
| Database (`database.init_db`) | Creates tables | `close_db` |
| Memory store (`memory_store.init`) | Creates brain SQLite tables | `close` |
| Gateway runner | `start_gateway` (no-op if disabled) | `stop` |
| Skill curator | `make_background_curator` (hourly loop) | task cancelled |
| Browser pool | lazy | `close_all` on shutdown |

All startup blocks are individually try/excepted so one failing service does
not prevent the app from booting.
