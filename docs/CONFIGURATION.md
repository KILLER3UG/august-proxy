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
9. [Workspace hooks (`.aug/hooks.json`)](#workspace-hooks-aughooksjson)

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

### `modelParams.families`

Per-model wire-capability families: which reasoning parameters a model id
accepts, and what effort it should use by default. Replaces two hard-coded
substring heuristics with data, so supporting a new gateway family is a config
edit rather than a code change.

**Settings → Model Families** (Agent Capabilities, Advanced) edits this section
for you: it shows the built-in table, and *Override* copies a built-in row — with
its tokens — into your list so narrowing it can't accidentally drop the models
the built-in matched. Saving there writes this file section through
`PUT /api/config/model-params`, which validates every entry and rejects the
whole write if one is malformed (a partially saved table would leave a model
silently sending no reasoning parameter). The change applies on the next
request — no restart.

```json
{
  "modelParams": {
    "families": [
      {
        "id": "acme-reasoner",
        "tokens": ["acme-r1", "acme-thinking"],
        "reasoningEffort": true,
        "extendedThinking": false,
        "excludes": ["acme-r1-lite"],
        "defaultEffort": "high"
      }
    ]
  }
}
```

| Field | Values | Meaning |
|-------|--------|---------|
| `id` | string | Family name; also the override key — a config family with a built-in's `id` replaces it |
| `tokens` | string[] | Matched as substrings of the lowercased model id |
| `reasoningEffort` | `bool` | May receive `reasoning_effort` (OpenAI-compatible / responses) |
| `extendedThinking` | `bool` | May receive Anthropic `thinking.budget_tokens` |
| `excludes` | string[] | Ids that reject the feature despite a `tokens` match |
| `defaultEffort` | `low` \| `medium` \| `high` \| `max` | Effort when neither the request nor the session sets one |
| `maxEffort` | same | Ceiling for this family |

Precedence: the per-model toggle in Model settings → a config family → a
built-in family → no reasoning parameter at all. Malformed entries are skipped
individually, and an unreadable config file falls back to built-ins, so a typo
cannot break chat. No built-in family sets `defaultEffort`, so adopting the
table changes no existing request; only entries you add do.

Owned by `app.providers.model_params`; consumed by
`app.services.workbench.effort` and `app.services.workbench.providers`.
Restart the backend after editing (or call `model_params.invalidate()`);
parity against the retired heuristics is pinned by
`backend-py/tests/test_model_params_parity.py`.

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
`maxWorkbenchToolLoops` here overrides the workbench tool-round cap (default `0 = uncapped`).

**Turn budget ladder** — three soft per-turn ceilings, each **off by default**
(`0` = disabled, so an untouched install never walks the ladder):

| Key | Type | Default | Fires when |
|-----|------|---------|-----------|
| `budgetSoftUsd` | float | `0` | This turn's estimated spend reaches it |
| `budgetSoftTokens` | int | `0` | This turn's prompt+output tokens reach it |
| `budgetWallClockSec` | int | `0` | This turn's monotonic wall clock reaches it |

Unlike the tool-round cap, a breach does **not** cut the turn off. It spends one
rung, once per round, and reports each as a `recovery` frame with
`kind: 'budget'`:

1. narrow the tool surface to the bare set (read/write/run_command/state);
2. compact the context, same prune→summarize pass the pre-turn auto-compact runs;
3. buy **one** tool-free round — the system prompt gains a `<turn_budget>`
   directive and no tools are advertised — then the turn ends.

The turn then ends as `turn_end {reason: 'budget'}`, which the transcript
renders as an amber **budget reached** badge. Cost is priced through
`cost_estimator.price_for_model` like every other surface, so the budget arm and
the Usage page can never disagree; the clock arm uses `time.monotonic()`, not
`time.time()`, so a wall-clock adjustment mid-turn cannot fake a breach. Arm
only what you want: any single key is enough, and the rungs still escalate in
order when several are set.

The two guardrails that keep this file and the UI honest —
`AUGUST_STRICT_BEST_EFFORT` and `npm run check:design` — are documented in
[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md#design-conventions-enforced-by-npm-run-checkdesign).

### Memory review and consolidation

**There is no user-facing "Review what I remember" feature.** `POST /api/memory/review`
and `/review/apply` were removed along with `routers/memory.py`, and the
`pending-consolidation` / `apply-consolidation` / `discard` trio never existed —
do not implement against them.

What is real:

- The **model** manages memory through tools: `remember` (write/update by key),
  `list_facts`, `forget`. All three are core tools, so progressive disclosure
  cannot hide the key lookup `remember` depends on, and a downgraded model can
  still correct what it remembers. Sub-agents read and recall but never write —
  the parent turn is the single write door.
- **Automatic recall** is the BM25 `<memory>` tail, gated by brain-config
  `memoryAutoInject` (**default `false`**). Independently of that gate,
  `kind='profile'` facts ride an always-in lane (~600-char budget) — that is what
  makes August remember who you are without a keyword coincidence. A fact dropped
  for budget is *named* in a `recall partial:` line rather than vanishing.
  The boot memory index is frozen per session to protect the provider prefix
  cache, so re-read `list_facts` after writing rather than trusting it.
- **Consolidation** is one scheduled job, not a multi-job daemon:
  `GET /api/brain/consolidation/log` and `POST /api/brain/consolidation/run`
  (explicit runs apply immediately).
- **Proposals** that need a human go through
  `GET /api/august/memory/proposals?status=pending` and
  `POST /api/august/memory/proposals/{id}/decide`. Approving a retire-preference
  proposal flips the fact's `status` to `retired`; the row survives, so it is
  reversible.
- Direct store browsing/editing is `GET /api/brain/stores[/{name}]` and
  `PATCH`/`DELETE /api/brain/stores/{name}/{id}`, plus `POST /api/august/memory/manage`.

### Harness / orchestrator

Session `agent_mode` is `chat` | `agent` | `code` | `orchestrator` (persisted
via workbench). Orchestrator mode uses Plan → Dispatch, named workstreams,
and harness jobs (`/api/subagents/workstreams*`, `/api/harness/*`, MCP
`harness_*` tools). The per-session verifier hard-gate
(`verifierEnforced` / composer shield) and the `AUGUST_VERIFIER_REVIEWER`
critic were **removed** (2026-08-24) — answers are never withheld.

### Skill relevance knobs

- `skillRelevanceMatch` (**default `true`**) gates the per-turn
  `<relevant_skills>` BM25 pass; `AUGUST_SKILL_RELEVANCE=0` forces it off.
- `skillKeywordExpansion` (**default `false`**) asks a cheap review model for
  5-10 search keywords when a skill is **written** (a `POST /api/skills` create,
  a `PATCH` that changes the body, or an approved harness skill proposal), stores
  them in the `keywords:` frontmatter line, and ranks on them alongside
  name/description/trigger. It is off by default because it costs one model call
  on the write path; it is best-effort in outcome — no provider, no key, a bad
  answer or a timeout all leave the skill written with no keywords, which is the
  pre-existing behavior. Only the cheap `make_review_llm_client` resolver is
  used, so a keyless install declines exactly like the lesson review does.
- A separate, always-on **demotion prior** applies to the same ranking: a skill
  whose turns measurably do *worse* than the same turns without it (the
  aggregation behind `GET /api/brain/skills/suggestions`, cached per process for
  60s) loses up to **0.5** BM25 points. A skill with no measurement is absent
  from that map and pays nothing — "unmeasured" and "measured, no effect" are
  different facts, and only the second one may move a ranking. The prior is a
  tiebreaker-sized demotion, never a filter.
- Retirement is proposal-only: see `docs/API_REFERENCE.md` → `/api/skills`.

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
    "guardMode": "full",
    "agentId": "",
    "modelProvider": "",
    "platforms": {
      "telegram": { "enabled": true, "webhook_path": "/api/gateway/telegram/webhook", "base_url": "" },
      "discord":  { "enabled": true },
      "slack":    { "enabled": true }
    }
  }
}
```

> **`gateway` keys are camelCase.** `services/gateway/runner.py` reads
> `cfg.get('guardMode')`, `cfg.get('agentId')`, `cfg.get('modelProvider')`. A
> `guard_mode` key is **silently ignored** — and because the code default is
> `'full'`, which is also the example value, writing the snake_case form appears
> to work until you set a different mode and nothing changes. This is the
> snake→camel migration miss; do not reintroduce it.

Bot tokens are normally env vars (see below). Optional SDKs:

```bash
# Discord + Slack adapters
cd backend-py && uv sync --extra gateway
# or: pip install -e ".[gateway]"
```

Missing `discord.py` / `slack_sdk` skips that adapter without blocking boot.
`GET /api/gateway/status` reports per-platform `available` / `reason` /
`installHint`.

### Older "profile" keys are inert

There is **no profile subsystem** — nothing in `app/` reads a `claude` / `codex`
/ `custom` profile shape (no `PROFILES` table, no such key anywhere). If an old
`config.json` still carries one, it is ignored rather than applied, so a model
that seems to "come from the profile" is actually coming from `modelAliases`,
`activeProvider` or `providers.json`. Configure those three.

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
| `quotaEndpoint` | Optional, opt-in. A provider quota endpoint August may call. Absent ⇒ August never calls one (see below) |
| `quotaAuth` | Optional auth for `quotaEndpoint` |

**Provider-native quota (truthful numbers only).** August never guesses a
provider's quota. A row in **Settings → Quotas** is `source: 'native'` only
when the provider itself stated a limit, and it comes from exactly two places:

1. **Standard rate-limit headers.** Every upstream response is checked for
   `x-ratelimit-limit` / `-remaining` / `-reset` (and the `-requests` /
   `-tokens` / `-input-tokens` / `-output-tokens` variants, plus the IETF
   `ratelimit-*` spelling). Stated values are copied verbatim into a small
   in-process observation store, keyed by provider + model. Reset hints are
   accepted as a duration (`6m0s`, `1h30m`), a bare epoch, or an ISO-8601
   timestamp. Observations older than an hour stop counting, so a stale header
   never reads as a live budget.
2. **An opt-in `quotaEndpoint` you declare.** August ships no provider quota
   adapters here on purpose — an adapter nobody verified against a real
   response is a made-up number. Instead you name the endpoint and the JSON
   paths:

```json
"quotaEndpoint": {
  "kind": "json",
  "url": "usage",
  "method": "GET",
  "headers": { "x-tenant": "acme" },
  "extract": {
    "model": "data.model",
    "limit": "data.quota.limit",
    "remaining": "data.quota.remaining",
    "used": "data.quota.used",
    "reset": "data.quota.reset_at"
  }
},
"quotaAuth": { "type": "bearer", "useProviderKey": true }
```

| `quotaEndpoint` field | Meaning |
|-------|--------|
| `kind` | Typed. `json` is the only supported response shape — it is the only one with a verified parser. An unknown kind is rejected at the write door (`422`) rather than silently never being called. |
| `url` | Absolute URL (used exactly as written) or a path joined onto `baseUrl` under the **same exact-base rule as chat** — no `/v1` is invented, so a base ending in `/v1` yields `…/v1/usage`. |
| `method` | `GET` (default) or `POST`; POST may carry a JSON `body`. |
| `headers` | Extra non-secret request headers. |
| `model` | Model id for an account-level endpoint that reports one aggregate budget. Optional — without it the reading stays account-level instead of being attributed to a model. |
| `extract.*` | Dotted JSON paths, `a.b[0].c` supported. **A path that does not resolve means "not stated", never zero.** With `limit` absent but `used` present the limit is not invented either — no native row is produced. |

| `quotaAuth` field | Meaning |
|-------|--------|
| `type` | `none` · `bearer` · `header` · `query`. |
| `useProviderKey` | Default `true` — reuses the provider's stored key so the secret is stored once. |
| `token` | For endpoints whose credential differs from the chat key. Write-only: the API returns `tokenSet`/`tokenMasked`, never the value. |
| `header` / `prefix` | For `type: 'header'`: header name and optional value prefix. |
| `param` | For `type: 'query'`: the query parameter name. |

The fetch is best-effort and bounded (8 s, failures logged at debug). Any
failure — unreachable host, non-JSON body, a path that does not resolve — falls
back to the local estimate. Configure it in **Settings → Models & Providers** →
provider → *Quota endpoint*.

**What the two numbers mean.** `used` is always August's own token spend in
the usage window. A native row adds `limit` / `remaining` / `nativeUsed`
straight from the provider, where `nativeUsed = limit − remaining` counts the
*provider's* window — a different quantity over a different period. The UI
labels the row *Reported by provider* and prints the provider's number on the
bar; the two are never substituted for one another.

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

**Per-model price (`priceInPerM` / `priceOutPerM`):** USD per **1,000,000**
tokens, set in **Settings → Models & Providers** → pencil-edit a model row →
*Price in / out ($/1M)*. Resolution order is env override
(`AUGUST_PRICE_IN_PER_M` / `AUGUST_PRICE_OUT_PER_M`) → the model's own price →
its **Free** flag → August's built-in family table → a last-resort default.
**0 is a price, not an absence**: a local or free-tier host should be set to
`0` (or ticked **Free**) so its spend reads `$0` instead of being estimated at
API rates. Anything resolved from the family table is a guess about somebody
else's price sheet, so the readout marks it *estimated* — a stored price is
what makes the number a fact. Table rows are best-effort public list prices
and are not kept current against provider sheets.

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
| `AUGUST_STRICT_BEST_EFFORT` | unset | `1` makes `best_effort(site)` blocks **re-raise** instead of logging. Production swallows a named, logged failure; under this flag the same failure fails the test, so what a swallow would have hidden surfaces in CI. Set in test runs |
| `AUGUST_P1_TOOL_CACHE` | on | `0` disables tool def cache |
| `AUGUST_P1_PROMPT_CACHE` | removed | never read in code (Part 25 Phase 7.2) — the segment/skills cache has no env kill-switch |
| `AUGUST_P1_PARALLEL_TOOLS` | on | `0` forces serial tools |
| `AUGUST_SQLITE_CACHE_KB` | unset | Opt-in SQLite page cache |
| `AUGUST_SQLITE_MMAP_MB` | unset | Opt-in mmap |
| `AUGUST_SQLITE_SYNC` | unset | Opt-in `NORMAL`/`FULL`/`OFF` |
| `AUGUST_HOST_AGENT_URL` | unset | External host-agent URL |
| `AUGUST_AUTO_ROUTE` | removed | was: force evidence-driven auto-routing on — never wired into the turn loop (removed Part 25 Phase 4) |
| `AUGUST_VERIFIER_REVIEWER` | removed | was: one-shot reviewer critique for the verifier gate (feature removed 2026-08-24) |
| `AUGUST_ANTHROPIC_PERSISTENT_CACHE` | unset | `1` swaps the Anthropic `cache_control: {type:"ephemeral"}` markers for the 1h-TTL variant so long sessions hold hits across longer gaps between turns. Off by default — 1h cache writes are billed at a premium upstream |
| `AUGUST_NGSPICE_EXE` | auto | Explicit ngspice executable for the circuit workbench. A value you set yourself that points at a real file always wins. Otherwise: bundled copy → PATH → `C:\ngspice\bin` → PATH-style install dirs. The desktop installer bundles ngspice 45.2 win64 at `src-tauri/resources/ngspice/`, staged by `prepare-desktop-backend.mjs` from the project's own archive and verified against a pinned SHA-256 before it is accepted; that tree is gitignored, so a checkout that never ran the staging step has no engine and falls through to PATH. `circuit_env` reports what was actually found |
| `AUGUST_QUARTUS_SH` | auto | Explicit `quartus_sh` path for `fpga_compile` (defaults to PATH + `C:\intelFPGA*\<ver>\quartus\bin64` discovery) |
| `AUGUST_KICAD_CLI` | auto | Explicit `kicad-cli` path for `kicad_checks` / `kicad_render` (defaults to PATH + `C:\Program Files\KiCad\<ver>\bin`) |
| `AUGUST_ARDUINO_CLI` | auto | Explicit arduino-cli path for `firmware_compile` |
| `AUGUST_AVR_GCC` | auto | Explicit avr-gcc path for plain-C `firmware_compile` |
| `AUGUST_NODE_EXE` | auto | Explicit Node runtime for the avr8js/wavedrom sidecar (defaults to the bundled Tauri node binary, then PATH) |
| `AUGUST_CONTAINER_SANDBOX` | unset | `1` routes `run_command` through a Docker container (workspace bind-mounted at `/workspace`, `--network none` unless the session allows network, memory/CPU caps) instead of host-process policy. Opt-in: needs Docker Desktop running; falls back to the host backend when the daemon is unreachable or the session has no workspace to mount, and Settings says so explicitly |
| `AUGUST_SANDBOX_IMAGE` | `python:3.12-slim` | Container image for the container backend — must carry a POSIX shell |
| `AUGUST_SANDBOX_MEMORY` | `2g` | Container memory cap (`--memory`) |
| `AUGUST_SANDBOX_CPUS` | `2` | Container CPU cap (`--cpus`) |
| `AUGUST_SANDBOX_APPCONTAINER` | unset | Windows-only. `1` opts in to the AppContainer tier. The tier activates **only** when the host actually accepts a `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` attribute list — see the note below. Most hosts (including Windows 11 26200) do not, so the effective tier stays `soft` |
| `AUGUST_WARM_KERNEL_OFF` | unset | `1` disables the persistent code-mode interpreter (also disabled automatically whenever a strong backend is active) |

### Sandbox enforcement tiers and the egress filter

Commands run through the strongest available backend: the container tier
(when enabled + Docker reachable) → Seatbelt (macOS) → bwrap (Linux, when
bubblewrap is installed) → AppContainer (Windows, when proven available) →
the host policy layer (`soft`: path scans, redirect checks, command denylists).

Landlock is **not** a tier even on kernels that support it. Applying a ruleset
needs a launcher August does not ship, so a "landlock" host is confined exactly
as little as a `soft` one — reporting it advertised OS isolation that did not
exist, and switched off the warm code-mode kernel on hosts that had no
isolation to lose.

`enforcement_report()` returns the distinction that used to be invisible:

| field | meaning |
|-------|---------|
| `effective` | the tier commands actually run under right now |
| `requested` | the strong tier you opted into, if any |
| `strong` | true when `effective` is real OS-level containment |
| `degraded` | true when a strong tier was requested but is **not** in force |
| `reason` | the concrete cause (`docker daemon is not answering…`) |

Doctor and Settings → Tool reach both render this. A requested-but-unavailable
tier shows a degraded banner naming what you asked for, what you got, and
why — it is never presented as a working boundary.

**Windows AppContainer is currently unavailable on most hosts.**
Availability is proven by building a real `SECURITY_CAPABILITIES` attribute
list (the same call `CreateProcessW` needs), not by checking that symbols
exist. On Windows 11 26200 the OS rejects that attribute with
`ERROR_INVALID_PARAMETER` (87) even though the profile SID derives
successfully and other attributes (`PARENT_PROCESS`, `HANDLE_LIST`) succeed
on the same list. The tier therefore stays off and the honest answer is
`soft`. An earlier revision checked only for symbol presence and reported
"Windows AppContainer isolation" while every command ran soft — that label is
not used unless the probe passes.

**Code mode and the warm kernel.** The persistent code-mode interpreter
spawns `python -I` directly and does not pass through the sandbox backends.
While a strong backend is active it is therefore disabled, and code cells run
one-shot through the sandboxed `run_command` path instead; kernels already
running are stopped at the transition. The cost is an interpreter boot per
cell — the alternative is code mode silently escaping a boundary the rest of
the session is held to.

When a session has `network: false`, sandboxed processes additionally get a
loopback egress filter env-injected (`HTTP(S)_PROXY` → a local proxy that
refuses CONNECT with `403`), so HTTP clients (urllib, requests, npm, pip…)
fail fast instead of reaching out. Honest scope: the filter constrains
HTTP-client traffic; raw sockets to hard-coded IPs still bypass it on the
host — that is what the container tier's `--network none` is for. Loopback
targets are exempt (`NO_PROXY=localhost,127.0.0.1`), so the model can still
talk to dev servers it spawned.

### Desktop app: sandbox opt-ins

The Tauri shell forwards `AUGUST_CONTAINER_SANDBOX`, `AUGUST_SANDBOX_*`,
`AUGUST_SANDBOX_APPCONTAINER` and `AUGUST_WARM_KERNEL_OFF` from the desktop
process into the bundled backend (`src-tauri/src/backend.rs`,
`applySandboxEnv`), on both the Python and Node spawn paths. Without this the
variables were read by the backend but never reached it, so a desktop user
setting `AUGUST_CONTAINER_SANDBOX=1` silently got soft enforcement.
Forwarded values are logged at launch and the resulting state is shown in
Settings → Tool reach.

### Arena & Debate routing evidence

The Arena and Debate views run several models on one prompt and record the
user's pick. Each verdict is persisted to the `routing_evidence` table
(`source='arena'`: one winner row `ok=1` + one loser row `ok=0` per model) and
served back:

- `POST /api/brain/routing/arena` — record a verdict `{sessionId, prompt,
  winner:{modelId,provider}, losers:[…]}`.
- `GET /api/brain/routing/arena` — the durable archive (recent verdicts, grouped
  per session in the UI).
- `GET /api/brain/routing/suggestions?prompt=…` — models ranked by recorded win
  rate (`wins`/`total`/`winRate`/`avgTokens`), surfaced in the composer's arena
  launcher.

There is **no automatic turn rerouting**: the earlier `AUGUST_AUTO_ROUTE` /
`autoRoute` "switch the model for you" design was never wired into the loop and
has been removed (Part 25 Phase 4). The `autoRouteMinSamples` brain-config key
remains (read by the harness self-improvement pass); the `autoRoute`,
`autoRouteMinWinRate`, and `autoRouteWinGap` keys are inert and slated for
removal with the dead-code purge.

### Anthropic prompt-cache 1h TTL (`AUGUST_ANTHROPIC_PERSISTENT_CACHE`)

By default the Anthropic adapter marks the last system block, the last tool
definition, and the last content block of the final user message with
`cache_control: { type: "ephemeral" }` so the stable prefix (system + tools
+ early history) hits the provider's prompt cache across turns
(`backend-py/app/adapters/anthropic.py:apply_prompt_caching`).

Ephemeral breakpoints live ~5 minutes and are refreshed on each hit, which
is plenty for normal sessions but loses hits across longer gaps (a user
steps away for 10 minutes, comes back, the prefix has expired and the next
turn pays full input-token cost). Setting `AUGUST_ANTHROPIC_PERSISTENT_CACHE=1`
swaps the markers for `cache_control: { type: "ephemeral", ttl: "1h" }` so
the prefix stays warm for an hour. The composer's ContextRing surfaces a
"Below goal — enable the 1h persistent cache" hint when the running
`cacheHitRate` drops under the 96% target, with a one-click link to the
model settings; the hint disappears when the rate is at or above target.

Cost trade-off: 1h cache writes are billed at a premium upstream. Only
opt in when the long-gap recovery matters more than the per-token write
premium — i.e. sessions that actually idle for minutes between turns.

The opt-in is per-process (env var, not brain config) so a single dev box
can run with the default while a long-running prod instance flips it on.

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

---

## Workspace hooks (`.aug/hooks.json`)

A workspace can register shell commands against harness events from
`<workspace>/.aug/hooks.json`:

```json
{ "hooks": [ { "name": "lint", "event": "pre_tool_use", "command": "./scripts/lint.sh" } ] }
```

These are loaded at the start of every prompt build, so a hand-edited file
takes effect on the next turn. Hooks run with `shell=True` **outside** the
sandbox, in the workspace as their working directory.

### Workspace hooks need approval; user hooks do not

`<dataDir>/hooks.json` is your own and always runs. A **workspace**
`.aug/hooks.json` only runs after you approve that workspace, because the file
arrives with the clone — and the model can create one and fire it in the same
turn, which would be remote code execution from an untrusted repo.

Approval is per workspace, keyed on its resolved path (`..` and symlinks
cannot launder one workspace's approval into another's), and persists across
restarts in `<dataDir>/trusted-hook-workspaces.json`. Manage it with:

```
POST /api/hooks/trust-workspace    {"sessionId": "..."}   # approve
POST /api/hooks/revoke-workspace  {"sessionId": "..."}   # withdraw
```

Both take a **`sessionId`, never a path** — August resolves the workspace from
its own session store, so a local caller cannot nominate a directory to run
commands from.

### When hooks are blocked, August says so

An untrusted workspace's hooks do not simply fail quietly. The count and path
appear in the next prompt, `GET /api/hooks` reports them under
`inactiveWorkspaceHooks`, and the trust list is what `workspaceTrusted` reads.
A workspace with no hooks file at all is untrusted *and* has nothing
suppressed, so it is not reported — the two states are deliberately distinct.

**If a hook you wrote never seems to run**, check `inactiveWorkspaceHooks`
first. The environment is scrubbed of secret-shaped variables before the
command is invoked, so a hook that reads `OPENAI_API_KEY` will not find it.


