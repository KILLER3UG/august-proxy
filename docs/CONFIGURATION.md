# Configuration Reference

August Proxy is configured through files in `data/` plus environment variables.
This document is the operator reference for current options.

---

## Table of Contents

1. [File overview](#file-overview)
2. [`data/config.json`](#dataconfigjson)
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

Dashboard provider picker selection; fallback when a request does not specify one.

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
Settings → Brain / fleet UI and `GET/PUT /api/config/cognitive`,
`GET/PUT /api/config/model-fleet`, and `/api/brain/config*`.

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

User-added providers, edited from **Settings → Model Providers** or
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
| `baseUrl` | Host + prefix only (e.g. `https://opencode.ai/zen/v1`). API format appends the leaf (`chat/completions`, `messages`, `responses`) |
| `apiFormat` | Wire format: `openaiChat` → `chat/completions`, `anthropicMessages` → `messages`, `openaiResponses` → `responses` |
| `apiKey` | Provider key (or rely on `config.json` / env) |
| `enabled` | Whether it is used |
| `autoFetch` | Re-fetch models on startup when supported |
| `models` | Cached catalog |

**OpenCode Zen:** one `baseUrl` + one `apiFormat` cannot cover every listed
model. Prefer `openaiChat` for DeepSeek / free / GLM / Kimi / MiniMax / Grok.
Claude and GPT on Zen need different formats/endpoints — fetching them into the
same provider still yields **404** on Test/chat until multi-endpoint routing
ships. Desktop **0.12.21+** also stops forwarding `session_id: null` on OpenAI
bodies (Console 400).

There is **no built-in template catalog**. You configure every provider
yourself (name, base URL, API format, API key) via Settings → Providers or
`POST /api/providers`. `GET /api/providers/templates` remains for back-compat
and always returns `[]`.

---

## `data/mcp-servers.json`

Defines MCP servers (stdio / SSE / streamable HTTP). Managed via
`/api/mcp/*` and Settings → MCP & Connections. Global env for MCP subprocesses
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
| `AUGUST_PROXY_ALLOWED_ROOTS` | unset | Semicolon-separated FS roots |
| `AUGUST_PROXY_WORKDIR` | unset | Default workdir |

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

### Plan & todo persistence (`.aug/`)

When the model creates a plan (`submit_plan`) or todos (`submit_todos`), copies
are persisted under the workspace `.aug/` directory and cleaned up when the
session is reset/rejected/deleted. Settings → Plans surfaces survivors.

### Implementation

- Loader / writer / generator: `backend-py/app/services/aug_directive_service.py`
- Artifact persistence: `backend-py/app/services/aug_artifact_service.py`
- API: `backend-py/app/routers/aug.py`
