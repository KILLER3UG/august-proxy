# Setup Guide

This guide takes you from a clean checkout to a running August Proxy with a
client connected.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Option A — Run with Docker (recommended)](#option-a--run-with-docker-recommended)
3. [Option B — Run locally with Python](#option-b--run-locally-with-python)
4. [First-run Configuration](#first-run-configuration)
5. [Pointing a Client at the Proxy](#pointing-a-client-at-the-proxy)
6. [Verifying It Works](#verifying-it-works)
7. [Stopping and Updating](#stopping-and-updating)
8. [Desktop (Tauri) — local development](#desktop-tauri--local-development)
9. [Frontend web / mobile](#frontend-web--mobile)

---

## Prerequisites

- An API key for at least one upstream (Anthropic, OpenAI, or any OpenAI-compatible
  endpoint such as OpenRouter / Opencode / MiniMax). See
  [`CONFIGURATION.md`](CONFIGURATION.md).
- **Docker** (for Option A) **or** **Python 3.12+** (for Option B; `uv` recommended).
- (Optional) Node.js for frontend development and Tauri desktop builds.
- (Optional) Dashboard already ships in `web-dist/`; rebuild from
  `frontend/desktop/` when you change the UI.

---

## Option A — Run with Docker (recommended)

Docker isolates dependencies and matches the production image (`python:3.12-slim`).

```bash
# 1. Create your secrets file
cp .env.example .env
#    Edit .env and add at least one provider API key.

# 2. Build and start the container
docker compose up --build -d

# 3. Confirm it is running
docker ps            # expect: august-proxy   Up
docker logs august-proxy --tail 30
```

The dashboard is served at **http://localhost:8085**. Compose maps host port
`8085` to container port `8085` (see `docker-compose.yml` and `Dockerfile` `EXPOSE 8085`).

`data/` is bind-mounted, so `config.json`, `providers.json`, the brain DB, and
logs persist across restarts. Source under `backend-py/`, `web-dist/`, and
`skills/` is also mounted for live-ish iteration.

---

## Option B — Run locally with Python

Use this for development, or when you don't want Docker.

```bash
cd backend-py

# Recommended: uv (respects requires-python >=3.12)
uv sync --group dev

# Or classic venv (must be Python >= 3.12 — check: python --version)
# python -m venv .venv
# Windows (PowerShell):     .venv\Scripts\Activate.ps1
# macOS / Linux:            source .venv/bin/activate
# pip install -e ".[dev]"

# (Optional) ML embeddings, browser automation, platform gateways
uv sync --extra ml
uv sync --extra gateway   # discord.py + slack_sdk for bot adapters
uv run playwright install chromium

# Run the server with hot reload
uv run uvicorn app.main:app --reload --port 8085

# Tests (always via uv / the project venv so the interpreter is 3.12+)
uv run pytest -q
# or from repo root: npm run test:backend
```

The server listens on **http://localhost:8085**. If `web-dist/` exists the
dashboard is served at `/`; otherwise run the Vite dev server and proxy `/api`
to `:8085` (see [Frontend web / mobile](#frontend-web--mobile)).

> **Note:** If you see `RuntimeError: asyncio.run() cannot be called from a
> running event loop` under uvicorn `--reload`, run without `--reload`.

The process **refuses to start on Python &lt; 3.12** (`main.py` fail-fast check).

---

## First-run Configuration

On first start, the proxy reads (or creates) files in `data/`. You can edit them
directly or use the dashboard (**Settings → Model Providers**).

### 1. Add API keys

Edit `data/config.json` and add your provider key under its name (or set env vars
in `.env` — see [`.env.example`](../.env.example)):

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai": { "apiKey": "sk-..." }
}
```

For OpenAI-compatible gateways (OpenRouter, Opencode, etc.), either store the key
under a matching name in `config.json` or put the key on the provider entry in
`providers.json`.

### 2. Set an active provider / model aliases (optional)

```json
{
  "activeProvider": "anthropic",
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

Aliases let clients request `sonnet` (or any friendly id) while the proxy routes
to the real model. Manage them from the dashboard or
`GET/PUT /api/config/model-aliases`.

### 3. Add a custom / OpenAI-compatible provider

Built-in **templates** (see `GET /api/providers/templates`) are currently:

- `anthropic` — Anthropic Messages API
- `openai` — OpenAI Chat Completions
- `openai-compatible` — any OpenAI-compatible base URL

Add further providers from **Settings → Model Providers** or by editing
`data/providers.json`:

```json
{
  "providers": [
    {
      "name": "My Gateway",
      "baseUrl": "https://api.example.com/v1",
      "apiFormat": "openaiChat",
      "apiKey": "sk-...",
      "enabled": true,
      "models": []
    }
  ]
}
```

See [`CONFIGURATION.md`](CONFIGURATION.md) for every field.

---

## Pointing a Client at the Proxy

The proxy exposes both the Anthropic Messages API and the OpenAI Chat
Completions API from the same port.

### Claude Code / Anthropic clients

```bash
export ANTHROPIC_BASE_URL=http://localhost:8085
# The proxy resolves the real key from your config; the client value is ignored.
export ANTHROPIC_API_KEY=dummy
claude
```

### OpenAI clients (Codex, Cline, Continue.dev, etc.)

```bash
export OPENAI_BASE_URL=http://localhost:8085
export OPENAI_API_KEY=dummy
codex
```

### Any "OpenAI-compatible" tool

Set base URL to `http://localhost:8085` and use any non-empty API key. The
proxy resolves the upstream key from `config.json` / `providers.json` / `.env`.

If **external access** is enabled (Settings → API Access), clients may need the
gateway API key (`GATEWAY_API_KEY` / generated key) — see
[`CONFIGURATION.md`](CONFIGURATION.md#external-access).

---

## Verifying It Works

```bash
# Health check (single endpoint — status, version, python, port, uptime)
curl http://localhost:8085/api/health
# -> {"status":"ok","version":"0.1.0","python":true,"port":8085,"uptime":...}

# Detailed health (mode, data dir, external access, brain sync, …)
curl http://localhost:8085/api/health/detailed

# List models the proxy advertises
curl http://localhost:8085/v1/models

# Send a test chat completion
curl http://localhost:8085/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"hi"}]}'
```

Then open **http://localhost:8085** in your browser to use the dashboard.

---

## Stopping and Updating

```bash
# Stop the container
docker compose down

# Rebuild after pulling updates
docker compose up --build -d

# Tail logs
docker logs august-proxy -f

# Shell into the container
docker exec -it august-proxy /bin/sh
```

If port `8085` is taken, change the host-side port in `docker-compose.yml`:

```yaml
ports:
  - "8086:8085"   # serve on host 8086, container still 8085
```

---

## Desktop (Tauri) — local development

The desktop app bundles the React SPA and launches the Python backend
(`backend-py/`) as a child process via uvicorn. First-run setup is a
one-shot script.

### Prerequisites

- **Python ≥ 3.12** on `PATH`. On Windows, the launcher `py -3` is
  preferred; the Microsoft Store `python.exe` stub is **not** a real
  interpreter and is explicitly rejected.
- **Node.js** (for the frontend build) and **Rust + VS C++ build tools**
  (for the Tauri shell — required to compile `src-tauri`).

### One-shot setup

```bash
# Windows (PowerShell, from repo root)
.\install.ps1

# macOS / Linux
./install.sh
```

`install.ps1` / `install.sh` will:

1. Resolve a Python ≥ 3.12 (prefers the `py` launcher, then `python3`).
2. Create `backend-py/.venv` and install the backend as an editable
   package (`pip install -e .`, or `uv sync` if `uv` is present).
3. Write a version stamp to `data/backend-version.txt`.

### Run the desktop app

```bash
npm install
npm run dev:desktop
```

The Tauri shell starts, probes `http://127.0.0.1:8085/api/health`,
and spawns the backend from the `.venv` interpreter (falling back to
`py -3`, then system `python3`). The Backend Monitor (Settings →
Backend Monitor) streams live proxy / memory / security events over
`ws://127.0.0.1:8085/api/logs/stream`.

### Packaging note

Release builds currently expect the `backend-py/` tree to be present next
to the executable (dev layout). Bundling an embedded Python + wheels is a
separate, optional phase.

---

## Frontend web / mobile

```bash
# From repo root (npm workspaces: frontend/desktop, frontend/mobile)
npm install

# Vite SPA only (proxies /api and WS to the backend)
npm run dev:web

# Production SPA build → web-dist/
npm run build:web

# Desktop Tauri
npm run dev:desktop

# Mobile companion (Expo) — see frontend/mobile/README / AGENTS.md
cd frontend/mobile && npm start
```

Root scripts (`package.json`):

| Script | Purpose |
|--------|---------|
| `npm start` | Start backend helper |
| `npm run dev` | Full dev app orchestrator |
| `npm run dev:desktop` | Tauri desktop |
| `npm run dev:web` | Vite only |
| `npm run build:web` | Build SPA into `web-dist/` |
| `npm run test` | Backend pytest + desktop vitest |
| `npm run release:desktop` | Build web + node binaries + Tauri release |
