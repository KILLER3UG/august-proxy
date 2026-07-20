# Troubleshooting

Common issues and how to resolve them.

---

## Table of Contents

1. [Startup & connectivity](#startup--connectivity)
2. [Models & providers](#models--providers)
3. [Workbench & chat](#workbench--chat)
4. [Gateway (Telegram / Slack / Discord)](#gateway-telegram--slack--discord)
5. [Browser automation](#browser-automation)
6. [Skills & curator](#skills--curator)
7. [Brain, memory & live](#brain-memory--live)
8. [Persistence & state](#persistence--state)
9. [Development](#development)
10. [Desktop (Tauri) backend](#desktop-tauri-backend)

---

## Startup & connectivity

### The server won't start

- Confirm **Python 3.12+**: `python --version`. Older versions fail fast in
  `main.py` with a clear `RuntimeError`.
- Confirm deps: `cd backend-py && uv sync --group dev` (or `pip install -e ".[dev]"`).
- If `uvicorn` is missing, install it via the project env.
- Port already in use? Change `--port` or `AUGUST_PROXY_PORT`, or edit
  `docker-compose.yml` `ports:` mapping.

### `docker compose up` fails

```bash
docker compose down
docker compose up --build -d
docker logs august-proxy --tail 50
```

Ensure `.env` exists (copy `.env.example`). Compose maps **`8085:8085`** (not
8080). `tty: true` / `stdin_open: true` are set for signal handling.

### Health check shape

`GET /api/health` is defined **once** in `main.py` and returns:

```json
{"status":"ok","version":"0.1.0","python":true,"port":8085,"uptime":12.3}
```

Use `GET /api/health/detailed` for mode, data dir, external access, brain sync,
and cognitive snapshots.

### A client can't reach the proxy

- Confirm listening: `curl http://localhost:8085/api/health`.
- Docker host port is `8085`.
- From WSL to a Windows host, use the Windows LAN IP, not always `localhost`.
- Some clients append `/v1` themselves — set base URL to
  `http://localhost:8085` (no trailing `/v1`).
- If external access is enabled, supply the gateway API key as required by
  Settings → API Access.

---

## Models & providers

### "No providers available" / empty model dropdown

A provider only appears as usable if it has an API key configured (config entry,
`providers.json` entry, or env). Add a key in `data/config.json` or `.env`, or
complete **Settings → Model Providers**.

### "API key not configured for &lt;provider&gt;"

The workbench checks credentials before calling the model. Resolution order is
roughly: `config.json` name → `providers.json` apiKey → env patterns. See
[`CONFIGURATION.md`](CONFIGURATION.md).

### Model alias not resolving

Aliases are validated when written: the provider must be known (template or
custom in `providers.json`) and the model non-empty. Edit via Aliases UI or
`PUT /api/config/model-aliases`.

### Custom provider not listed

Confirm `data/providers.json` has `"enabled": true` and a key. Restart is usually
not required — `settings.reload()` runs after writes.

### Only three templates?

Built-in templates are intentionally thin (`anthropic`, `openai`,
`openai-compatible`). Most third-party gateways are **custom OpenAI-compatible
providers**. That is expected, not a missing install step.

### Upstream rate limiting (429 / 503)

Provider clients retry with exponential backoff (capped, honors `Retry-After`).
If it persists, spread traffic or reduce parallelism.

### Workbench / Test: `session_id: … received null` (OpenCode Console)

**Fixed in desktop 0.12.21.** Earlier builds dumped `session_id: null` (and other
nulls) on OpenAI-compatible upstream calls. OpenCode’s Console Zod schema rejects
that; free DeepSeek Flash often still worked. Desktop workbench chat, the model
**Test** button, and `/v1/chat/completions` now use `dump_openai_upstream_body`
(`exclude_none` + strip August-only keys). Ship/reinstall **0.12.21+** for
installed desktop users (bundled backend).

### Models list OK but Test / chat returns **Not Found** (OpenCode Zen)

`GET …/models` returns the full Zen catalog. Each model family still needs a
different wire path (`/chat/completions`, `/messages`, `/responses`, or Gemini’s
Google-style path). August picks **one** `apiFormat` per provider. With
`openaiChat`, only chat-completions models work (DeepSeek, GLM, Kimi, MiniMax,
Grok, free tier). Claude needs `messages`; GPT needs `responses` — those will
**404** under a single Zen `openaiChat` provider until per-model routing exists.
See [`CONFIGURATION.md`](CONFIGURATION.md) (OpenCode note).

Paste the provider base URL **exactly**. August does **not** invent `/v1` on
the base — it only appends the API format leaf (`chat/completions`,
`v1/messages`, `responses`, or `/models` for discovery). Anthropic’s format
already includes `v1` in the leaf.

---

## Workbench & chat

### Chat returns nothing / the model "stops" after tools

Workbench only enables Anthropic **extended thinking** for Claude model ids
(or explicit non-wildcard model profiles). Non-Claude anthropicMessages
gateways (e.g. MiniMax) no longer get `thinking` forced by a wildcard
`supportsReasoning: true` profile. If a turn still ends empty after tools,
check server logs for upstream errors / empty re-call warnings and confirm
the model id is valid on the provider.

### Plan mode never executes

In `plan` mode, destructive tools are blocked until a plan is approved. The model
must call `submit_plan`, then approve via `POST /api/workbench/plan/approve` or
the dashboard banner.

### Context keeps getting compacted

Compression triggers when estimated tokens exceed half the workbench token budget.
Disable with `AUGUST_SUMMARIZING_COMPACTOR=0`.

### Sessions don't persist across restarts

Sessions are stored in **`data/august_brain.sqlite`** (source of truth). The
in-memory cache keeps the last 50 by `updatedAt`. Optional JSON export to
`workbench-sessions.json` is **off by default**. In-flight SSE does not survive
process death.

### A generation won't stop

`POST /api/workbench/chat/stop` with `{sessionId}` sets the cancellation signal
and emits `aborted`.

---

## Gateway (Telegram / Slack / Discord)

### Adapter not starting

- `gateway.enabled: true` in `config.json`.
- Platform enabled under `gateway.platforms.<name>.enabled`.
- Bot tokens set (`AUGUST_TELEGRAM_BOT_TOKEN`, etc.).
- SDKs installed where required. Missing `discord.py` / `slack_sdk` logs a
  warning and skips that adapter — the app still boots. Install with
  `pip install -e ".[gateway]"` (or `uv sync --extra gateway`). Check
  `GET /api/gateway/status` → `platforms[].available` / `reason`.

### Telegram webhook not receiving

Set `gateway.platforms.telegram.base_url` to a public HTTPS URL for `setWebhook`.
Leave empty for long-poll local dev.

### Messages arrive out of order

One in-flight agent turn per platform session. Extra messages queue. Use `/new`
or `/stop`.

### `/approve` says "No pending plan"

The plan must belong to the mapped workbench session. Start `/new` if mapping is
stale.

---

## Browser automation

### "Playwright is not installed"

```bash
pip install playwright   # or uv / project env
python -m playwright install chromium
```

Import is lazy; the rest of the proxy works without it.

### Domain blocked

Non-empty `browserAllowlist` restricts navigation. Clear or extend the list.

### Browser session leaks across workbench sessions

Each workbench session id gets an isolated context/page. Confirm tools read the
workbench session context var. Stale sessions close on shutdown.

---

## Skills & curator

### "Refusing to delete bundled skill"

Bundled skills under `skills/` cannot be deleted — archive via curator. Agent
skills under `data/skills/` can be deleted.

### Skill name rejected

Names must match the skill service validators (lowercase, length, no marketing
words in description). See `skill_service` validation helpers.

### Curator archived a skill I need

Archived under `data/skills/.archive/<name>/`. Restore with
`POST /api/curator/restore/{name}` or pin with `/pin/{name}`.

---

## Brain, memory & live

### Brain dashboard empty / no search hits

Confirm brain DB path (`AUGUST_DATA_DIR` / `august_brain.sqlite`). FTS requires
correct table-level `MATCH` queries — app-path regressions are covered by
`tests/test_fts_app_path.py`. Do not run invasive scripts against a live DB
while the server is writing.

### Live STT/TTS returns 501

Server speech is optional. Configure an OpenAI-compatible speech provider under
Live config, or use browser Web Speech (product default).

### Feature Flow shows nothing

Emits fire on proxy / tool / memory paths. Use Settings → Feature Flow and
confirm `/api/monitor/events`. Backend Monitor uses `WS /api/logs/stream`
instead.

---

## Persistence & state

### How to reset runtime state

Stop the server first.

```bash
# Sessions + memory + audit (destructive)
rm -f data/august_brain.sqlite data/august_brain.sqlite-wal data/august_brain.sqlite-shm

# Optional JSON export / logs
rm -f data/workbench-sessions.json data/request-log.json

# Agent skill archive only
rm -rf data/skills/.archive
```

Keep `config.json`, `providers.json`, and `mcp-servers.json` unless you intend
to wipe configuration.

### Audit log

Config audit lives primarily in the brain DB / audit APIs
(`GET /api/august/audit`, `GET /api/audit`). Older docs referring only to
`august_audit_log.jsonl` may be outdated for your install.

### Database is locked

Only one server instance should own the brain SQLite. WAL files (`-wal`, `-shm`)
are normal; delete them only when the server is stopped. Under contention, prefer
diagnosing duplicate processes rather than deleting the DB.

---

## Development

### `asyncio.run() cannot be called from a running event loop`

Run uvicorn without `--reload`, or avoid nested `asyncio.run` in request paths.

### Circular imports

Large subsystems import each other lazily. Move new cross-subsystem imports
inside functions if you hit a cycle.

### Tests fail only on Windows

Use the project venv / `uv run pytest`. Prefer
`.\scripts\install-git-hooks.ps1` if Device Guard blocks
`.venv\Scripts\python.exe` for pre-commit.

### `git commit` fails: pre-commit Permission denied on venv python

Windows Application Control may block the project venv. Install hooks via:

```powershell
py -3 -m pip install pre-commit
.\scripts\install-git-hooks.ps1
git hook run pre-commit
```

Do not re-run stock `pre-commit install` from the blocked venv afterward.

### Tests mutated my real data

They should not — `isolatedData` is **autouse**. If you see writes under
`data/`, stop and report: something may have bypassed isolation.

---

## Desktop (Tauri) backend

### Backend won't start / "no provider"

- Probe URL is `http://127.0.0.1:8085/api/health` (with `/api`).
- Python resolution: project `.venv` → `py -3` → system `python3`/`python`.
  Microsoft Store `WindowsApps` stub is rejected.
- Spawn failures: Tauri `backend_last_error` and `data/logs/backend.log` when present.

### Backend Monitor shows nothing live

- Events: `ws://127.0.0.1:8085/api/logs/stream`. Vite must proxy `/api` with
  `ws: true`.
- Categories are stable strings (`proxy_incoming`, `auto_memory`, `security`, …).
- Empty monitor usually means no traffic yet or a broken WS proxy.

### `pip install` hangs on desktop start

Dependency install is not run synchronously on every Tauri start — use
`install.ps1` / `install.sh` once, or the background sync when the version stamp
is stale.
