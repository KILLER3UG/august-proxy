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
{"status":"ok","version":"<backend version>","python":true,"port":8085,"uptime":12.3}
```

`version` is resolved by `app/version.py:backend_version()` from
`backend-runtime.json` (installed desktop) or root `package.json`, and falls back
to the literal `"0.1.0"` when neither is reachable — so a `0.1.0` readout means
the stamp is missing, not that the build is old.

Use `GET /api/health/detailed` for mode, data dir, external access, brain sync,
and cognitive snapshots.

### A client can't reach the proxy

- Confirm listening: `curl http://127.0.0.1:8085/api/health`.
- Docker host port is `8085`.
- From WSL to a Windows host, use the Windows LAN IP, not always `localhost`.
- Some clients append `/v1` themselves — set base URL to
  `http://127.0.0.1:8085` (no trailing `/v1`).
- If external access is enabled, supply the gateway API key as required by
  Settings → API Access.

---

## Models & providers

### "No providers available" / empty model dropdown

A provider only appears as usable if it has an API key configured (config entry,
`providers.json` entry, or env). Add a key in `data/config.json` or `.env`, or
complete **Settings → Models & Providers**.

### "API key not configured for &lt;provider&gt;"

The workbench checks credentials before calling the model. Resolution order is
roughly: `config.json` name → `providers.json` apiKey → env patterns. See
[`CONFIGURATION.md`](CONFIGURATION.md).

### Model alias not resolving

Aliases are validated when written: the provider must be a configured entry in
`providers.json` (there are no templates) and the model non-empty. Edit via the
Aliases UI or `PUT /api/config/model-aliases`.

### Custom provider not listed

Confirm `data/providers.json` has `"enabled": true` and a key. Restart is usually
not required — `settings.reload()` runs after writes.

### "There are no provider templates"

Correct, and by design. There is **no built-in template catalog** —
`GET /api/providers/templates` is a back-compat shim that always returns `[]`.
Every provider, including Anthropic and OpenAI, is user-configured: name, base
URL, wire format, key. Most third-party gateways are **custom OpenAI-compatible
providers**, and `openaiChat` + the right `baseUrl` covers them. That is not a
missing install step.

### Upstream rate limiting (429 / 503)

Provider clients retry with exponential backoff (capped, honors `Retry-After`).
If it persists, spread traffic or reduce parallelism.

### Quotas stay on "local" and no cap appears

That is the intended behaviour, not a bug: August only shows a cap the provider
actually published.

* **Check the provider sends standard rate-limit headers.** August reads
  `x-ratelimit-limit` / `-remaining` / `-reset` (with the `-requests` /
  `-tokens` variants, or the IETF `ratelimit-*` spelling) on every response.
  Most gateways publish them only on some routes — a `/models` probe may carry
  none, so make one real chat call and the reading appears.
* **Readings expire after an hour** on purpose; a header from yesterday is not a
  live budget. Make a call, or configure a quota endpoint, to refresh it.
* **A `remaining` without a `limit` is not a quota row.** Some providers report
  only what is left in a rolling window. That value is not a cap, so August
  does not draw a bar from it.
* **For a provider with no headers**, declare its usage endpoint: Settings →
  Models & Providers → provider → *Quota endpoint*. A blank URL means August
  never calls anything. Check the extractor paths against a real response
  (`curl` it with your key) — a path that does not resolve is treated as "not
  stated", not as zero. `GET /api/providers/quota?provider=X` shows what came
  back; a `local` row means nothing usable was extracted.
* **A relative `quotaEndpoint.url` never gains a `/v1`.** Against a base of
  `https://host/v1`, `"url": "usage"` calls `https://host/v1/usage`. Paste the
  full path if the host wants it elsewhere.

### Workbench / Test: `session_id: … received null` (OpenCode Console)

**Fixed in desktop 0.12.21.** Earlier builds dumped `session_id: null` (and other
nulls) on OpenAI-compatible upstream calls. OpenCode’s Console Zod schema rejects
that; free DeepSeek Flash often still worked. Desktop workbench chat, the model
**Test** button, and `/v1/chat/completions` now use `dump_openai_upstream_body`
(`exclude_none` + strip August-only keys). Ship/reinstall **0.12.21+** for
installed desktop users (bundled backend).

### Models list OK but Test / chat returns **Not Found** (OpenCode Zen)

`GET …/models` returns the full Zen catalog. Each model family needs a
different wire path (`/chat/completions`, `/v1/messages`, `/responses`).
August now supports a **per-model `apiFormat` override**: in **Settings →
Model settings → Providers**, pencil-edit the failing model row and pick its
wire format in the **Wire format** dropdown (`v1/messages` for Claude,
`responses` for GPT; chat-completions models keep "Auto (provider format)").
The override is honored by workbench chat, the Test button, and the
`/v1/chat/completions` · `/v1/messages` · `/v1/responses` proxy adapters —
an OpenAI-format request routed to a Claude model is translated to the
Anthropic wire protocol automatically (and vice versa for `/v1/messages`).
See [`CONFIGURATION.md`](CONFIGURATION.md) (per-model apiFormat note).

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
the desktop plan-approval banner.

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

### Sub-agents: background completions continue on their own

The spawn tools (`spawn_subagent` / `spawn_subagents`) default to background
execution. When a sub-agent settles **after the parent turn already ended**, the
backend starts a coalesced continuation turn (drained within ~1.5 s of the last
completion) so the parent model still receives the result. Consecutive
auto-started turns are capped at **4 per user turn**; beyond that the
completions stay queued for the next user message. The chat thread shows these
auto-turns because the active-streams poller reconnects newly-streaming
sessions and the per-turn handler bundle persists its SSE position.

### Sub-agent roster & runs

- Live roster: right-drawer **Subagents** section (auto-opens while workers are
  active); per-run history in **Brain → Runs**.
- API-created agent jobs (`POST /api/agents/jobs`) now also appear in Runs.
- Workbench sessions persist `agentMode` and `turnCount` across restarts —
  a session switched to `chat`/`code` mode stays in that mode.

### Sub-agents and git worktrees

Automatic per-sub-agent worktree isolation was **removed** — tool dispatch
resolves paths against the parent session's workspace, so the worktrees were
created but never used. Parallel agents share the main tree by default. An
explicit isolated worktree is still available on demand via
`POST /api/workbench/sessions/{id}/worktree`.

### Terminal sandbox

The in-app terminal is a real shell. One-shot commands
(`POST /api/terminal/command`) and multi-token interactive input lines in a
workspace-bound terminal get the same soft sandbox as the workbench shell:
path escapes outside the workspace, redirects, and network prefixes are
blocked. `cd …` navigation and single-token inputs (answers, bare commands)
pass through. Non-workspace terminals are unrestricted.

### MCP server edit

MCP servers can be added, started/stopped, edited (`PATCH /api/mcp/servers/{id}`),
and removed from **Settings → Integrations**. Editing stops a running server so
the new command/args/env apply on the next start.

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

### Curator retired a skill I need

There is no `.archive/` directory and no restore endpoint — curation lifecycle is
a **`SKILL.md` frontmatter flag** (draft / active / superseded / retired; `stale` and `archived` are
rejected by `setStatus` — see `skill_service.SKILL_STATUSES`), and
the old `POST /api/curator/restore/{name}` / `/pin/{name}` routes never survived
the curator rewrite.

To bring one back, fix the frontmatter. `PATCH /api/skills/{name}` flips
`disabled` and rewrites `body` / `description` / `trigger` / `category`, but it
does **not** accept a `status` field — so the status line is corrected by editing
the skill file. Beware: `_apply_approved` rewrites frontmatter **wholesale**, so
any approved patch that does not restate `status`, `trigger`, `supersedes`,
`origin` and `learned_from` drops them. Losing `trigger` silently retires the
skill from per-turn relevance matching.

For a curator *proposal* (rather than a lifecycle flag), rollback is
`POST /api/curator/refine/{entry_id}/rollback`.

---

## Brain, memory & live

### Memory / brain search empty / no hits

Confirm brain DB path (`AUGUST_DATA_DIR` / `august_brain.sqlite`). FTS requires
correct table-level `MATCH` queries — app-path regressions are covered by
`tests/test_fts_app_path.py`. Do not run invasive scripts against a live DB
while the server is writing.

### Live STT/TTS returns 501

Server speech is optional. Configure an OpenAI-compatible speech provider under
Live config, or use browser Web Speech (product default).

### Feature Flow shows nothing

Emits fire on proxy / tool / memory paths. Use Settings → Feature Flow
(advanced) and confirm `/api/monitor/events`. Live logs use
`WS /api/logs/stream` (Settings → Activity Log).

### "Memory review" / the review chip

There is no memory-review feature any more. `POST /api/memory/review` and
`/review/apply` were removed along with `routers/memory.py`, and the chat chip
that called them is gone — so a bookmark or script hitting those paths gets a 404,
not a bug in your install.

What exists instead:

- The model manages memory through **tools**: `remember` (write/update by key),
  `list_facts`, `forget`. These are core tools, so progressive disclosure can
  never hide them and a downgraded model can still correct what it remembers.
- Automatic recall is the BM25 `<memory>` tail, gated by brain-config
  **`memoryAutoInject` (default OFF)**. Recall happens when the model calls
  `brain_query`.
- `kind='profile'` facts are an **always-in lane** regardless of that gate
  (rendered first, ~600-char budget). That is what makes August remember who you
  are without a keyword coincidence.
- Reviewing what is stored is **Settings → Memory**, one flat chronological list
  across kinds. There is no "Memory files" card — the 0.18 restyle removed the
  backup / integrity / restore surface.

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

Use the project venv / `uv run pytest -n auto`. Prefer
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

### Activity Log / live events show nothing

- Events: `ws://127.0.0.1:8085/api/logs/stream`. The old Backend Monitor
  settings id still deep-links here.
- Categories are stable strings (`proxy_incoming`, `auto_memory`, `security`, …).
- Empty stream usually means no traffic yet or a broken WS proxy.

### `pip install` hangs on desktop start

Dependency install is not run synchronously on every Tauri start — use
`install.ps1` / `install.sh` once, or the background sync when the version stamp
is stale.

### Auto-update downloads the full installer (Windows)

Desktop **0.12.x** on Windows updates by downloading the full GitHub-release
NSIS setup (`August_<version>_x64-setup.exe`) and launching it — the user
walks through the setup wizard like a first install. This deliberately
replaced the earlier quiet in-place patch, which could miss bundled backend
changes. The download streams via the `download_release_installer` Tauri
command with `update-download-progress` events; the app then stops the backend
and calls `launch_installer_and_exit`. Non-Windows keeps the in-place
`@tauri-apps/plugin-updater` path. If the download stalls, check the GitHub
Releases URL in `frontend/desktop/src/hooks/useAppUpdate.ts`.
