# Configuration Reference

August Proxy is configured through three files in `data/` plus environment
variables. This document is the complete reference for every option.

---

## Table of Contents

1. [File overview](#file-overview)
2. [`data/config.json`](#dataconfigjson)
3. [`data/providers.json`](#dataprovidersjson)
4. [Environment variables (`.env`)](#environment-variables-env)
5. [Settings precedence](#settings-precedence)
6. [Runtime paths](#runtime-paths)

---

## File overview

| File | Loaded by | Holds |
|------|-----------|-------|
| `data/config.json` | `app.config.settings` | API keys per provider, `modelAliases`, `activeProvider`, `subAgentFallback`, `auxiliary.background_review`, `security`, profile-style overrides |
| `data/providers.json` | `app.config.settings` | User-added **custom** providers (name, base URL, API format, fetched models) |
| `.env` | Pydantic Settings + Docker Compose | API keys, port, data dir, gateway bot tokens |

All three are hot-reloadable: most services call `settings.reload()` after a
write so resolvers see the change immediately. The model-service cache is also
invalidated on alias changes.

---

## `data/config.json`

### Provider API keys

Each provider's key lives under its own (lowercase, display, or alias) name.
The resolver tries the display name, every alias, and env-var base names.

```json
{
  "anthropic":  { "apiKey": "sk-ant-..." },
  "openrouter": { "apiKey": "sk-or-v1-..." },
  "kilo":       { "apiKey": "eyJ..." },
  "opencode-zen": { "apiKey": "sk-..." },
  "gemini":     { "apiKey": "AIza..." },
  "minimax":    { "apiKey": "sk-cp-..." },
  "nvidia":     { "apiKey": "nvapi-..." }
}
```

### `activeProvider`

The provider name selected by the dashboard's provider picker. Used as a
fallback when a request does not specify one.

```json
{ "activeProvider": "anthropic" }
```

### `modelAliases`

A list of friendly names mapping to a concrete `{provider, model}`. Aliases are
the primary way clients request models (e.g. `sonnet`, `claude-sonnet-4-6`).
Each entry is validated: the provider must be known, and the model must be
non-empty.

```json
{
  "modelAliases": [
    {
      "alias": "sonnet",
      "targetModel": "claude-sonnet-4-20250514",
      "targetProvider": "anthropic",
      "displayAlias": "Sonnet"
    },
    {
      "alias": "claude-sonnet-4-6",
      "targetModel": "deepseek-v4-flash",
      "targetProvider": "opencode-zen",
      "displayAlias": "Sonnet 4 6-Alias"
    }
  ]
}
```

Managed by [`app.services.alias_service`](../backend-py/app/services/alias_service.py)
and exposed at `GET/PUT /api/config/model-aliases` and
`POST /api/august/aliases/manage`. Every change is recorded in the config
audit log.

### `subAgentFallback`

Configures automatic provider/model fallback when a sub-agent's primary model
is unavailable. Consumed by [`app.services.workbench.subagent`](../backend-py/app/services/workbench/subagent.py).

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

Provider+model are validated against known providers whenever the fallback is
active. Exposed at `GET/PUT /api/config/subagent-fallback` and `POST .../test`.

### `auxiliary.background_review`

A side LLM used by the interval-gated background review loop (which authors
skills from conversations). Defaults to the session's main provider when unset.

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

Exposed at `GET/PUT /api/config/background-review`.

### `security`

Filesystem and browser safety controls.

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
| `security.allowedRoots` | Semicolon- or list-separated roots the host-agent tools may touch |
| `security.filesystemScope` | `allowlist` (restrict) or unrestricted |
| `browserAllowlist` | Domains the browser tools may navigate to; empty = unrestricted |

### Profile-style overrides (legacy compatibility)

A small number of keys mirror the legacy Node profiles and are still honoured
by some paths:

```json
{
  "claude": { "currentModel": "claude-opus-4-6", "contextWindow": 128000 },
  "codex":  { "currentModel": "gpt-4o", "contextWindow": 128000 },
  "custom": { "baseUrl": "https://api.tokenrouter.com/v1", "apiKey": "sk-..." }
}
```

New integrations should prefer `modelAliases` + `activeProvider`.

---

## `data/providers.json`

User-added custom providers, edited from the dashboard's **Providers** page or
[`app.services.config_service`](../backend-py/app/services/config_service.py).

```json
{
  "providers": [
    {
      "id": "opencode-zen-3777ae",
      "name": "Opencode Zen",
      "baseUrl": "https://opencode.ai/zen/v1",
      "apiFormat": "openai-chat",
      "apiKey": "sk-...",
      "enabled": true,
      "autoFetch": false,
      "models": [
        { "id": "claude-opus-4-6", "name": "claude-opus-4-6", "contextWindow": 128000, "reasoning": false, "free": false, "source": "fetched" }
      ]
    }
  ]
}
```

| Field | Values |
|-------|--------|
| `name` | Unique display name; used for key resolution |
| `baseUrl` | Upstream base URL (no trailing slash) |
| `apiFormat` | `openai-chat` \| `anthropic-messages` \| `codex-responses` |
| `apiKey` | Provider key (stored here or via env var) |
| `enabled` | Whether the runner will use it |
| `autoFetch` | Re-fetch the model list on startup |
| `models` | Cached model catalog |

---

## Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in your keys.

### API keys

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `KILOCODE_API_KEY` | Kilo |
| `OPENCODE_API_KEY` | Opencode (`/zen/v1`) |
| `OPENCODE_GO_API_KEY` | Opencode Go (`/zen/go/v1`) |
| `CLINE_API_KEY` | Cline |
| `MINIMAX_API_KEY` | MiniMax |
| `NVIDIA_API_KEY` | NVIDIA NIM |
| `GEMINI_API_KEY` | Google Gemini |
| `SUPERMEMORY_API_KEY` | Supermemory |

### Runtime

| Variable | Default | Meaning |
|----------|---------|---------|
| `AUGUST_PROXY_PORT` | `8085` | Host port the server listens on |
| `AUGUST_DATA_DIR` | `<repo>/data` | Where config/DBs/logs live |
| `AUGUST_BRAIN_SQLITE_FILE` | `<data_dir>/august_brain.sqlite` | Memory KV DB path |
| `AUGUST_SUMMARIZING_COMPACTOR` | `1` (enabled) | Set to `0` to disable context compression |

### Gateway bot tokens

| Variable | Platform |
|----------|----------|
| `AUGUST_TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `AUGUST_DISCORD_BOT_TOKEN` | Discord bot token |
| `AUGUST_SLACK_BOT_TOKEN` | Slack bot token (`chat:write`, history scopes) |
| `AUGUST_SLACK_APP_TOKEN` | Slack app-level token (Socket Mode) |

### Gateway configuration

The gateway itself is enabled in `config.json`:

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

### External services

| Variable | Purpose |
|----------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Workspace (Gmail/Calendar/Drive) |
| `GOOGLE_OAUTH_REDIRECT_URI` | OAuth redirect (optional) |

---

## Settings precedence

For a given provider, the API key is resolved in this order
([`BaseProviderClient.resolve_api_key`](../backend-py/app/providers/clients/base.py)):

1. `config.json → {providerName}.apiKey` (tries display name, aliases, env-var base names)
2. The provider's declared `env_vars`
3. Standard env-var patterns: `{NAME}_API_KEY`, `{NAME}_KEY`, `{NAME}_APIKEY`

For model resolution, aliases take precedence over raw model ids
([`app.providers.model_resolver`](../backend-py/app/providers/model_resolver.py)).

---

## Runtime paths

`app.lib.paths.data_path(*parts)` resolves paths under `settings.data_dir`.
All persistent state lives there:

| Path | Contents |
|------|----------|
| `config.json` | See above |
| `providers.json` | See above |
| `august_brain.sqlite` | Memory KV, config audit log |
| `august-sessions.db` | Workbench sessions, agent registry |
| `workbench-sessions.json` | Workbench session history (last 50) |
| `august_core_memory.json` | Core memory (user profile, projects) |
| `august_semantic_memory.json` | Key-value facts |
| `august_infinite_memory.json` | Vector DB of conversation summaries |
| `skills/` | Agent-authored skills + `.usage.json` + `.archive/` |
| `browser_screenshots/` | Browser tool screenshots |
| `request-log.json` | Tracked request log (inspector) |
