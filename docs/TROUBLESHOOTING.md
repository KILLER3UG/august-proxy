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
7. [Persistence & state](#persistence--state)
8. [Development](#development)

---

## Startup & connectivity

### The server won't start

- Confirm **Python 3.13+**: `python --version`.
- Confirm deps are installed in the active venv: `pip install -e ".[dev]"`.
- If `uvicorn` is missing, install it: `pip install uvicorn[standard]`.
- Port already in use? Change `--port` or `AUGUST_PROXY_PORT`, or edit
  `docker-compose.yml` `ports:` mapping.

### `docker compose up` fails

```bash
docker compose down
docker compose up --build -d
docker logs august-proxy --tail 50
```

Make sure `.env` exists (copy `.env.example`). On some Docker Desktop setups the
container needs `tty: true` and `stdin_open: true` (already set in the compose
file) to handle signals correctly.

### Health check returns unexpected shape

`GET /api/health` is registered by both `main.py` and `monitoring.py`. The
last registration wins and returns `{status, port, uptime}` without a `python`
field. If you need the `python: true` marker, use `/api/health/detailed`
(which returns `mode: "python"`). See the review report for the route-collision
finding.

### A client can't reach the proxy

- Confirm the server is listening: `curl http://localhost:8085/api/health`.
- For Docker, the host port is `8085` (maps to container `8080`).
- From WSL reaching a Windows host, use the Windows LAN IP, not `localhost`.
- Some clients append `/v1` themselves — set the base URL to
  `http://localhost:8085` (no trailing `/v1`).

---

## Models & providers

### "No providers available" / empty model dropdown

A provider only appears in `/api/config/activeProvider` if it has an API key
configured. Add the key in `data/config.json` under the provider name, or set
the matching env var in `.env`. See [`CONFIGURATION.md`](CONFIGURATION.md) for
the resolution order.

### "API key not configured for <provider>"

The workbench checks credentials before calling the model. The resolver tries:
`config.json → {name}.apiKey`, then the provider's `env_vars`, then
`{NAME}_API_KEY` / `{NAME}_KEY` / `{NAME}_APIKEY` env vars. Add the key under
any of these.

### Model alias not resolving

Aliases are validated when written: the provider must be a *known* provider
(built-in or custom in `providers.json`) and the model must be non-empty. An
unknown-model is a soft warning, but an unknown provider is a hard error. Edit
the alias from the dashboard's **Aliases** tab or `PUT /api/config/model-aliases`.

### Custom provider not listed

Confirm it is in `data/providers.json` with `"enabled": true` and that its
`apiKey` is set. Restart not required — `settings.reload()` is called after
writes.

### Upstream rate limiting (429 / 503)

The provider client retries automatically with exponential backoff (capped at
30s, honoring `Retry-After`). If it persists, spread traffic across multiple
providers/keys or reduce parallelism.

---

## Workbench & chat

### Chat returns nothing / the model "stops" after tools

This can happen if a non-thinking-capable model is routed through the Anthropic
streaming path (see the review report's critical finding). Symptoms: the
assistant produces no `final_output` after a tool round, or an `AttributeError`
on `NoneType` in the logs. Workaround until fixed: use a model whose provider
profile sets `supportsThinking: true`, or route through an OpenAI-format provider.

### Plan mode never executes

In `plan` mode, destructive tools are blocked until a plan is approved. The
model must call `submit_plan`, then you approve via `POST /api/workbench/plan/approve`
or the dashboard banner. Once approved, mutations run on the next tool round.

### Context keeps getting compacted

Compression triggers when estimated tokens exceed half the `WORKBENCH_TOKEN_BUDGET`
(1,000,000 tokens). To disable it, set `AUGUST_SUMMARIZING_COMPACTOR=0`. The
estimator is character-based (CJK-aware) and slightly overestimates.

### Sessions don't persist across restarts

Only the last 50 sessions (by `updatedAt`) are saved to
`data/workbench-sessions.json`. In-flight background tasks do not survive a
restart; the SSE stream simply ends.

### A generation won't stop

Call `POST /api/workbench/chat/stop` with `{sessionId}`. This sets the
cancellation signal and emits an `aborted` event to SSE subscribers.

---

## Gateway (Telegram / Slack / Discord)

### Adapter not starting

- Gateway must be enabled in `config.json → gateway.enabled: true`.
- The specific platform must be enabled under `gateway.platforms.<name>.enabled`.
- Bot tokens must be set: `AUGUST_TELEGRAM_BOT_TOKEN`, `AUGUST_DISCORD_BOT_TOKEN`,
  `AUGUST_SLACK_BOT_TOKEN` / `AUGUST_SLACK_APP_TOKEN`.
- The required SDK must be installed (`discord.py`, `slack_sdk`). Missing SDKs
  log a warning and the adapter is skipped — the app still boots.

### Telegram webhook not receiving

Set `gateway.platforms.telegram.base_url` to your public HTTPS URL so the
adapter calls `setWebhook` on startup. For local dev, leave `base_url` empty to
fall back to long-polling.

### Messages arrive out of order

Each platform session gets one in-flight agent turn at a time (first guard).
A second message arriving while a turn runs is queued and processed after. Use
`/new` to start fresh, or `/stop` to cancel the running turn.

### `/approve` says "No pending plan"

The plan must have been submitted by the model in the same session the gateway
mapped to. Confirm the session mapping with the gateway status endpoint, or
start a new session with `/new`.

---

## Browser automation

### "Playwright is not installed"

Install it: `pip install playwright` then `python -m playwright install chromium`.
The import is lazy, so the rest of the proxy works without it.

### Domain blocked

If `config.json → browserAllowlist` is non-empty, only listed domains (and
their subdomains) are allowed. Clear the list or add the domain.

### Browser session leaks across workbench sessions

Each workbench session id gets its own isolated browser context/page. If you
see leakage, confirm the tool is reading `current_session_id.get()` (set by
the workbench before dispatch). Stale sessions are torn down on app shutdown.

---

## Skills & curator

### "Refusing to delete bundled skill"

Bundled skills (in `skills/`) cannot be deleted — archive them via the curator
instead. Agent-authored skills (in `data/skills/`) can be deleted.

### Skill name rejected

Names must match `^[a-z0-9][a-z0-9._-]*$` and be ≤64 chars. Descriptions must
be ≤60 chars and contain no marketing words ("revolutionary", "cutting-edge",
etc.). See `skill_service._validate_name` / `_validate_description`.

### Curator archived a skill I need

Archived skills move to `data/skills/.archive/<name>/`. Restore via
`POST /api/curator/restore/{name}`, or pin frequently-used skills with
`POST /api/curator/pin/{name}` to exempt them from auto-transitions.

---

## Persistence & state

### How to reset everything

```bash
# Stop the server, then remove runtime state:
rm -f data/workbench-sessions.json
rm -f data/august_brain.sqlite*
rm -f data/august_core_memory.json data/august_semantic_memory.json
rm -f data/august_infinite_memory.json
rm -rf data/skills/.archive
```

`config.json` and `providers.json` are **not** runtime state — keep them.

### Audit log grows large

`data/august_audit_log.jsonl` records every config change. Query it with
`GET /api/august/audit?limit=`. To trim, stop the server and edit the file.

### Database is locked

The brain SQLite uses a thread-local connection. If you see "database is
locked", another process may hold it — ensure only one server instance is
running. The WAL files (`-wal`, `-shm`) are normal and safe to delete when the
server is stopped.

---

## Development

### `asyncio.run() cannot be called from a running event loop`

Run uvicorn without `--reload`, or use the ASGI entry directly. The workbench
and gateway rely on the running event loop; synchronous helpers that need async
results should use `asyncio.to_thread` or be made `async`.

### Circular imports

Large subsystems (`workbench`, `gateway`, `skills`) import each other lazily
(inside functions). If you add a cross-subsystem import at module top level
and hit a circular import, move the import inside the function that needs it.

### Tests fail only on Windows

The venv produces `.exe` binaries under `.venv/Scripts/` on Windows. Run
`.venv\Scripts\pytest.exe` directly, or activate the venv first. Path
separators in a few data files are normalized to the host OS.

---

## Desktop (Tauri) backend

### Backend won't start / "no provider"

- The Tauri shell probes `http://127.0.0.1:8085/api/health` (note
  the `/api` prefix — the bare `/health` path does not exist on the
  Python server). If the probe is wrong the SPA never learns the
  `baseUrl` and the Backend Monitor shows "Disconnected".
- Resolution order for the Python interpreter is: project `.venv`
  (`backend-py/.venv/.../python`) → `py -3` launcher → system
  `python3`/`python`. The **Microsoft Store** `python.exe` stub under
  `WindowsApps` is a dead-end redirect and is explicitly rejected — if
  you only have that, install a real Python 3.12+ from python.org.
- The most recent spawn failure is surfaced by the `backend_last_error`
  Tauri command and written to `data/logs/backend.log`.

### Backend Monitor shows nothing live

- Events come from `ws://127.0.0.1:8085/api/logs/stream`. In
  `npm run dev:desktop` the Vite dev server proxies `/api` with
  WebSocket upgrade (`ws: true`). If you moved the proxy config, ensure
  `/api` uses the object form `{ target, ws: true }`, not a bare
  string.
- Categories are `snake_case` (`proxy_incoming`, `proxy_upstream`,
  `auto_memory`, `security`, …). The monitor UI keys off these exactly.
- If the monitor is empty, confirm the backend actually received proxy
  traffic — emits fire on `/v1/*` requests and on auto-memory writes.

### `pip install` hangs / is slow

- Dependency install is **never** run synchronously inside the Tauri
  startup. It happens once via `install.ps1` / `install.sh`, or as a
  background `syncBackendDeps` when the version stamp is stale.
