# Configuration Reference

August Proxy is configured through files in `data/` plus environment variables.
This document is the operator reference for current options.

---

## Table of Contents

1. [File overview](#file-overview)
2. [`data/config.json`](#dataconfigjson) (includes memory review + harness notes)
3. [`data/providers.json`](#dataprovidersjson)
4. [`data/mcp-servers.json`](#datamcp-serversjson)
5. [Environment variables (`.env`)](#environment-variables-env)
6. [Settings precedence](#settings-precedence)
7. [Runtime paths](#runtime-paths)
8. [AUG.md (project instructions)](#augmd-project-instructions)

---

## File overview

| File | Loaded by | Holds |
|------|-----------|-------|
| `data/config.json` | `app.config.settings` | API keys, `modelAliases`, `activeProvider`, `subAgentFallback`, `auxiliary.*` (cognitive, background review, session export, …), `security`, `gateway` |
| `data/providers.json` | `app.config.settings` | User-added providers (name, base URL, API format, models) |
| `data/mcp-servers.json` | MCP client | MCP server process definitions |
| `data/august_brain.sqlite` | `memory_store` | Sessions, messages, memory, audit, graph/vector |
| `.env` | Pydantic Settings + `load_dotenv` + Docker Compose | API keys, port, data dir, OAuth, gateway tokens |

Most services call `settings.reload()` after a write so resolvers see changes
without a full process restart. Alias changes also invalidate model caches.

---

## `data/config.json`

### Provider API keys

Keys can live under a provider’s name (and aliases). The resolver tries display
name, aliases, and env-var base names.

```json
{
  "anthropic":  { "apiKey": "sk-ant-..." },
  "openai":     { "apiKey": "sk-..." },
  "openrouter": { "apiKey": "sk-or-v1-..." }
}
```

Custom providers may also store `apiKey` on the entry in `providers.json`.

### `activeProvider`

Desktop chat model picker selection; fallback when a request does not specify one.

```json
{ "activeProvider": "anthropic" }
```

### `modelAliases`

Friendly names → concrete `{provider, model}`. Validated on write (known provider,
non-empty model).

```json
{
  "modelAliases": [
    {
      "alias": "sonnet",
      "targetModel": "claude-sonnet-4-20250514",
      "targetProvider": "anthropic",
      "displayAlias": "Sonnet"
    }
  ]
}
```

Managed by `app.services.alias_service` and exposed at
`GET/PUT /api/config/model-aliases` and `POST /api/august/aliases/manage`.
Changes go to the config audit log.

### `subAgentFallback`

Automatic provider/model fallback when a sub-agent’s primary model is unavailable.

```json
{
  "subAgentFallback": {
    "enabled": true,
    "mode": "marked_subagent_only",
    "provider": "openrouter",
    "model": "anthropic/claude-3.5-sonnet"
  }
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `enabled` | `bool` | Master switch |
| `mode` | `off` \| `session_only` \| `marked_subagent_only` \| `always` | When fallback applies |
| `provider` | string | Fallback provider name |
| `model` | string | Fallback model id |

`GET/PUT /api/config/subagent-fallback`, `POST …/test`.

### `auxiliary.background_review`

Side LLM for interval-gated background review (authors skills / saves facts).
Defaults toward the session main provider when unset.

```json
{
  "auxiliary": {
    "background_review": {
      "enabled": true,
      "provider": "openrouter",
      "model": "anthropic/claude-3.5-sonnet"
    }
  }
}
```

`GET/PUT /api/config/background-review`.

### `auxiliary.cognitive`

Cognitive architecture tree (boot, features, fleet, orchestrator). Edited via
Settings → Memory / Reliability / model fleet and `GET/PUT /api/config/cognitive`,
`GET/PUT /api/config/model-fleet`, and `/api/brain/config*`.
`maxWorkbenchToolLoops` here overrides the workbench tool-round cap (default 25).

### Memory review (selected chat model)

Not a `config.json` key. The desktop composer chip **Review what I remember**
calls `POST /api/memory/review` with the **currently selected chat model**.
The model returns improve / remove / always-include suggestions only.
`POST /api/memory/review/apply` writes **after the user confirms** each row.
This is separate from hippocampus consolidation (which can still apply
background plans). Idle sleep-cycle distill stashes a plan at
`GET /api/brain/pending-consolidation`; Keep is `POST /api/brain/apply-consolidation`,
Discard is `POST /api/brain/pending-consolidation/discard`. Explicit
Settings “run consolidation now” still applies immediately.

### Harness / orchestrator

Session `agent_mode` is `chat` | `agent` | `code` | `orchestrator` (persisted
via workbench). Orchestrator mode uses Plan → Dispatch, named workstreams,
and harness jobs (`/api/subagents/workstreams*`, `/api/harness/*`, MCP
`harness_*` tools). The per-session verifier hard-gate
(`verifierEnforced` / composer shield) and the `AUGUST_VERIFIER_REVIEWER`
critic were **removed** (2026-08-24) — answers are never withheld.

### `auxiliary.session_json_export`

Optional continuous backup of sessions to `workbench-sessions.json`.
**SQLite remains source of truth.**

```json
{
  "auxiliary": {
    "session_json_export": {
      "enabled": false
    }
  }
}
```

Env override: `AUGUST_SESSION_JSON_EXPORT=1`. Status: `GET/PUT /api/config/session-export`.

### Live speech (`/api/config/live`)

Controls browser vs server STT/TTS preferences and provider binding for
`/api/live/*`. Unconfigured server speech returns 501.

### Web search / extract (`/api/config/web`)

Controls `auxiliary.web` — search/extract backends, API keys, and response
compress thresholds used by the web search / web fetch managed tools.
`GET/PUT /api/config/web`; PUT accepts a partial body filtered to known fields.

### External access

```json
{
  "gateway": {
    "externalAccess": {
      "enabled": false
    }
  }
}
```

`GET/PUT /api/config/external-access`, `POST …/generate-key`. Also
`GATEWAY_API_KEY` in `.env`.

### Inject AUG on proxy

`GET/PUT /api/config/inject-aug-on-proxy` — when enabled, injects workspace
`AUG.md` into `/v1/*` proxy requests (not only workbench).

### `security` & browser allowlist

```json
{
  "security": {
    "allowedRoots": ["C:\\Dev\\myproject"],
    "filesystemScope": "allowlist",
    "postObservationScreenshot": true
  },
  "browserAllowlist": ["example.com", "docs.example.com"]
}
```

| Field | Meaning |
|-------|---------|
| `security.allowedRoots` | Roots host/desktop tools may touch |
| `security.filesystemScope` | `allowlist` vs unrestricted |
| `browserAllowlist` | Domains browser tools may open; empty = unrestricted |

Also editable via `GET/PUT /api/security`.

### Gateway platforms

```json
{
  "gateway": {
    "enabled": true,
    "provider": "anthropic",
    "model": "sonnet",
    "guard_mode": "full",
    "platforms": {
      "telegram": { "enabled": true, "webhook_path": "/api/gateway/telegram/webhook", "base_url": "" },
      "discord":  { "enabled": true },
      "slack":    { "enabled": true }
    }
  }
}
```

Bot tokens are normally env vars (see below). Optional SDKs:

```bash
# Discord + Slack adapters
cd backend-py && uv sync --extra gateway
# or: pip install -e ".[gateway]"
```

Missing `discord.py` / `slack_sdk` skips that adapter without blocking boot.
`GET /api/gateway/status` reports per-platform `available` / `reason` /
`installHint`.

### Profile-style overrides (legacy)

A small number of keys may still mirror older profile shapes (`claude`, `codex`,
`custom`). Prefer `modelAliases` + `activeProvider` + `providers.json`.

---

## `data/providers.json`

User-added providers, edited from **Settings → Models & Providers** or
`app.services.config_service`.

```json
{
  "providers": [
    {
      "id": "opencode-zen-3777ae",
      "name": "Opencode Zen",
      "baseUrl": "https://opencode.ai/zen/v1",
      "apiFormat": "openaiChat",
      "apiKey": "sk-...",
      "enabled": true,
      "autoFetch": false,
      "models": [
        {
          "id": "deepseek-v4-flash-free",
          "name": "deepseek-v4-flash-free",
          "contextWindow": 128000,
          "reasoning": false,
          "free": true,
          "source": "fetched"
        }
      ]
    }
  ]
}
```

| Field | Values |
|-------|--------|
| `name` | Display name; used for key resolution |
| `baseUrl` | Exact host + prefix as pasted. OpenAI-compatible: include `/v1` in the base if the host needs it. Anthropic format appends `v1/messages` itself (do not rely on inventing `/v1` on the base). |
| `apiFormat` | Wire leaf: `openaiChat` → `chat/completions`, `anthropicMessages` → `v1/messages`, `openaiResponses` → `responses` |
| `apiKey` | Provider key (or rely on `config.json` / env) |
| `enabled` | Whether it is used |
| `autoFetch` | Re-fetch models on startup when supported |
| `models` | Cached catalog. Each model entry may carry its own `apiFormat` override (see below) |

**Per-model `apiFormat` override (multi-format gateways):** a model entry may
carry its own `apiFormat` — e.g. `"id": "claude-sonnet-4", "apiFormat":
"anthropicMessages"` — which wins over the provider-level format for that
model. This is how OpenCode Zen works: one provider (`openaiChat`) serves
DeepSeek / GLM / Kimi / MiniMax / Grok on `chat/completions`, while Claude
models tagged `anthropicMessages` route to `v1/messages` and GPT models tagged
`openaiResponses` route to `responses`. Set it in **Settings → Models & Providers** (pencil-edit a model row → Wire
format dropdown; the UI suggests `v1/messages` for `claude-`-prefixed ids).
The override applies to workbench chat, the **Test** button, Live/BTW, and
the `/v1/chat/completions` · `/v1/messages` · `/v1/responses` proxy adapters
(OpenAI-format requests to a Claude model are translated to the Anthropic
wire protocol automatically).

Desktop **0.12.21+** also stops forwarding `session_id: null` on OpenAI
bodies (Console 400).

There is **no built-in template catalog**. You configure every provider
yourself (name, base URL, API format, API key) via Settings → Models & Providers or
`POST /api/providers`. `GET /api/providers/templates` remains for back-compat
and always returns `[]`.

---

## `data/mcp-servers.json`

Defines MCP servers (stdio / SSE / streamable HTTP). Managed via
`/api/mcp/*` and Settings → Integrations. Global env for MCP subprocesses
is available at `/api/mcp-env` (includes Google OAuth keys mirrored at boot).

---

## Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in keys. Values are loaded into
`os.environ` (project root and `backend-py/.env`) without overriding already-set
process env.

### API keys (common)

| Variable | Provider / use |
|----------|----------------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `KILOCODE_API_KEY` | Kilo |
| `OPENCODE_API_KEY` | Opencode (`/zen/v1`) |
| `OPENCODE_GO_API_KEY` | Opencode Go |
| `CLINE_API_KEY` | Cline |
| `MINIMAX_API_KEY` | MiniMax |
| `NVIDIA_API_KEY` | NVIDIA NIM |
| `GEMINI_API_KEY` | Google Gemini |
| `SUPERMEMORY_API_KEY` | Supermemory (if used) |
| `GATEWAY_API_KEY` | External access / gateway auth |

### Runtime

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUGUST_PROXY_PORT` | `8085` | Server listen port |
| `AUGUST_DATA_DIR` | `<repo>/data` | Config / DB / logs root |
| `AUGUST_BRAIN_SQLITE_FILE` | under data dir | Override brain DB path |
| `AUGUST_SUMMARIZING_COMPACTOR` | enabled | Set `0` to disable context compression |
| `AUGUST_SESSION_JSON_EXPORT` | unset | `1` enables JSON session backup |
| `AUGUST_PERF_TIMING` | unset | Perf ring buffer + logging |
| `AUGUST_P1_TOOL_CACHE` | on | `0` disables tool def cache |
| `AUGUST_P1_PROMPT_CACHE` | on | `0` disables prompt segment cache |
| `AUGUST_P1_PARALLEL_TOOLS` | on | `0` forces serial tools |
| `AUGUST_DB_WRITER_LOW_DROP_S` | ~2s | Low-pri queue age drop |
| `AUGUST_SQLITE_CACHE_KB` | unset | Opt-in SQLite page cache |
| `AUGUST_SQLITE_MMAP_MB` | unset | Opt-in mmap |
| `AUGUST_SQLITE_SYNC` | unset | Opt-in `NORMAL`/`FULL`/`OFF` |
| `AUGUST_HOST_AGENT_URL` | unset | External host-agent URL |
| `AUGUST_AUTO_ROUTE` | unset | `1` forces evidence-driven auto-routing on (equivalent to brain config `autoRoute: true`) |
| `AUGUST_VERIFIER_REVIEWER` | removed | was: one-shot reviewer critique for the verifier gate (feature removed 2026-08-24) |

### Evidence-driven auto-routing

The routing-evidence loop picks the best model per task type from recorded
turn outcomes. With **auto-routing** on (Settings → Activity Log / Reliability,
or `AUGUST_AUTO_ROUTE=1`), a turn whose task type has enough
samples is automatically switched to the evidence-best model; otherwise the
candidate is surfaced as a suggestion only (shown in the model picker).

Thresholds (brain config, `PUT /api/brain/config`, defaults in parens):

| Key | Default | Meaning |
|-----|---------|---------|
| `autoRoute` | `false` | Master switch (UI toggle in the Reliability dashboard) |
| `autoRouteMinSamples` | `3` | Minimum evidence turns for a task type before routing |
| `autoRouteMinWinRate` | `0.6` | Candidate must win ≥ this share of its turns |
| `autoRouteWinGap` | `0.15` | Candidate must beat the current model's win rate by ≥ this much (flap guard) |

Routed turns are recorded with `source='auto-route'` (still counting toward
model win rates) and every decision is logged — see
`GET /api/brain/routing/decisions` and the Reliability dashboard's
"Recent auto-route decisions".

### Gateway bot tokens

| Variable | Platform |
|----------|----------|
| `AUGUST_TELEGRAM_BOT_TOKEN` | Telegram |
| `AUGUST_DISCORD_BOT_TOKEN` | Discord |
| `AUGUST_SLACK_BOT_TOKEN` | Slack bot token |
| `AUGUST_SLACK_APP_TOKEN` | Slack app-level (Socket Mode) |

### Google OAuth (service connections)

| Variable | Purpose |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client id (Desktop + PKCE recommended) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Optional for confidential clients |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match Google console (default loopback callback) |
| `OAUTHLIB_INSECURE_TRANSPORT` | `1` for local http:// redirects |
| `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID` | Optional ship-time public Desktop client id |

---

## Settings precedence

For a given provider, the API key is resolved roughly as:

1. `config.json → {providerName}.apiKey` (name / aliases)
2. `providers.json` entry `apiKey`
3. Provider-declared env vars / standard `{NAME}_API_KEY` patterns

For model resolution, aliases take precedence over raw model ids
(`app.providers.model_resolver`).

---

## Runtime paths

`app.lib.paths.dataPath(*parts)` resolves under `settings.dataDir`
(`AUGUST_DATA_DIR`):

| Path | Contents |
|------|----------|
| `config.json` | See above |
| `providers.json` | User providers |
| `mcp-servers.json` | MCP servers |
| `august_brain.sqlite` | **SoT** for sessions, memory, audit, graph/vector |
| `workbench-sessions.json` | Optional session **export** only |
| `request-log.json` | Request inspector log |
| `skills/` | Agent-authored skills + `.usage.json` + `.archive/` |
| `browser_screenshots/` / observations | Tool screenshots |
| `august_graph_memory.json` | Legacy import source if present |

**Not used as current SoT:** `august-sessions.db`,
`august_core_memory.json`, `august_semantic_memory.json`,
`august_infinite_memory.json` (historical docs may still mention them).

---

## AUG.md (project instructions)

`AUG.md` is the project instruction file for the workbench — analogous to
Claude Code’s `CLAUDE.md`. Plain markdown for build/test commands, conventions,
and architecture.

### Scope & discovery

Workspace-relative: read from the session’s `workspacePath`. If unset, falls
back to the August Proxy project root. No parent-directory walk-up in the
current version.

### How it is used

Each chat turn assembles a multi-tier system prompt. `AUG.md` body is injected
as soft context (truncated if huge). Changes invalidate the prompt cache for
the active session. Optional injection on the pure proxy path is controlled by
`inject-aug-on-proxy`.

### Frontmatter

Optional YAML frontmatter; `description` is used today. Path-scoped `paths:`
filtering is not active.

### The `/init` command

Type `/init` in the chat composer to generate or refine `AUG.md` for the current
workspace (preview → save). API: `/api/aug/*`.

### Implementation

- Loader / writer / generator: `backend-py/app/services/aug_directive_service.py`
- API: `backend-py/app/routers/aug.py`

---

## Workspace template & guaranteed tools

New workspaces inherit the Docker image toolchain (or host `scripts/ensure-toolchain.sh` visibility check).

**Guaranteed CLIs:** `uv` (Python), `pnpm` + `npm`/`node` (JS), `ripgrep` (`rg`), `fd` (`fd-find`), `jq`. Verified by `scripts/ensure-toolchain.sh` and baked into `Dockerfile` (`apt: ripgrep fd-find jq` + `npm i -g pnpm`).

**Run manually:** `bash scripts/ensure-toolchain.sh` (host) or `docker exec august-proxy bash /app/scripts/ensure-toolchain.sh`.

