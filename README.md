# August Proxy

August Proxy is a multi-provider AI gateway and agentic workbench. It presents an
OpenAI-compatible Chat Completions API **and** an Anthropic-compatible Messages
API from a single local endpoint, routes each request to a configurable upstream
provider, and ships a full agentic layer on top: a streaming workbench chat loop,
managed tools, persistent memory (brain), skills, sub-agents, browser automation,
desktop automation, platform gateways, and a Tauri desktop + Expo mobile UI.

It is the successor to an earlier Node.js HTTP bridge. The server is written in
**Python 3.12+** (FastAPI) under [`backend-py/`](backend-py). The primary UI is a
**React + Vite + TypeScript** SPA in [`frontend/desktop/`](frontend/desktop)
(Tauri shell optional); compiled output is served from [`web-dist/`](web-dist).
A companion Expo app lives in [`frontend/mobile/`](frontend/mobile).

---

## Highlights

- **Dual API surface** — `POST /v1/chat/completions` (OpenAI), `POST /v1/messages`
  (Anthropic), plus `POST /v1/responses` (OpenAI Responses-style SSE synthesis)
  with bidirectional format translation and streaming.
- **User-configured providers** — add any Anthropic- or OpenAI-compatible
  gateway yourself (name, base URL, format, API key) in Settings or
  `data/providers.json`. Model aliases map friendly names to provider + model.
- **Workbench** — streaming chat with multi-round tool loop, effort / thinking
  budgets, plan-mode approval gate, todos, checkpoints, context compression,
  message queue / steer, worktrees, and fire-and-forget background review /
  self-evolution.
- **Managed tools** — file ops, shell/PTY terminal, web search/fetch, browser
  (Playwright), desktop automation, memory, MCP, skills, sub-agents, and
  self-configuration tools.
- **Brain & learning** — SQLite-backed core/semantic/vector/graph memory, skill
  curator lifecycle, cognitive fleet config, consolidation daemons, heuristics,
  and a Brain dashboard (status, search, graph, diagnostics, activity stream).
- **Live / voice** — browser speech (product default) plus optional server STT/TTS
  over OpenAI-compatible providers; Live session API under `/api/live`.
- **Platform gateways** — Telegram, Slack, and Discord adapters with one in-flight
  turn per session and control commands (`/stop`, `/new`, `/approve`, …).
- **Integrations** — MCP servers (`mcp-servers.json`), Google OAuth service
  connections, cron jobs, automations, exam flow, git helpers, security /
  observability surfaces.
- **Desktop app** — Tauri shell launches the Python backend, Backend Monitor over
  WebSocket log stream, auto-update settings.

---

## Repository Layout

```text
august-proxy/
├── backend-py/              # FastAPI server (Python ≥ 3.12)
│   ├── app/
│   │   ├── main.py          # FastAPI app, lifespan, router registration
│   │   ├── config.py        # Settings: config.json + providers.json + .env
│   │   ├── adapters/        # Anthropic & OpenAI message/SSE translation
│   │   ├── providers/       # Templates, clients, resolvers
│   │   ├── routers/         # /api/* and /v1/* HTTP routes
│   │   └── services/        # workbench, gateway, memory, skills, tools, …
│   ├── tests/               # pytest suite (isolatedData autouse)
│   └── pyproject.toml
├── frontend/
│   ├── desktop/             # React + Vite SPA + Tauri (src-tauri)
│   └── mobile/              # Expo companion app
├── web-dist/                # Compiled SPA served by the backend
├── data/                    # Persistent state: config, providers, brain DB, logs
├── skills/                  # Bundled SKILL.md packs
├── docs/                    # Project documentation
├── scripts/                 # Dev, install, release helpers
├── Dockerfile
└── docker-compose.yml
```

---

## Quick Start

### Prerequisites

- Python **3.12+** (or Docker — see below)
- An API key for at least one provider (Anthropic, OpenAI, or any OpenAI-compatible endpoint)

### Run with Docker

```bash
cp .env.example .env          # then edit .env and add your API keys
docker compose up --build -d
```

The dashboard is served at **http://localhost:8085** (host and container both use port `8085`).

### Run locally (development)

```bash
cd backend-py
# Recommended
uv sync --group dev
uv run uvicorn app.main:app --reload --port 8085

# Or classic venv
# python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
# pip install -e ".[dev]"
# uvicorn app.main:app --reload --port 8085
```

Frontend:

```bash
npm install
npm run dev:web          # Vite only, proxy /api → :8085
# or full desktop shell:
npm run dev:desktop      # Tauri + backend
```

Build the SPA into `web-dist/` with `npm run build:web` so the backend can serve it at `/`.

### Point a client at the proxy

```bash
# Claude Code / Anthropic clients
export ANTHROPIC_BASE_URL=http://localhost:8085
claude

# OpenAI clients / Codex / Cline / Continue.dev
export OPENAI_BASE_URL=http://localhost:8085
export OPENAI_API_KEY=dummy   # the proxy uses the key from your config
codex
```

---

## Configuration

Configuration lives in `data/` and is split across these files:

| File | Purpose |
|------|---------|
| `data/config.json` | Provider API keys, model aliases, active provider, sub-agent fallback, cognitive/auxiliary config, security, gateway |
| `data/providers.json` | User-added providers (name, base URL, API format, models) |
| `data/mcp-servers.json` | MCP server definitions |
| `data/august_brain.sqlite` | Brain / sessions / memory / audit (source of truth) |
| `.env` | API keys and runtime env vars (Docker Compose + Pydantic Settings) |

API keys are resolved per-provider: `config.json → {provider}.apiKey`, then the
provider's declared env vars, then standard `{NAME}_API_KEY` patterns. See
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md).

---

## Documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [`docs/SETUP.md`](docs/SETUP.md) | All users | Installation, first-run, clients, desktop |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Operators | Config / providers / env reference |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Developers | Request flow, workbench, brain, gateway |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Integrators | HTTP endpoints and SSE conventions |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, extension points |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | All users | Common issues and fixes |
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | Everyone | Full doc index (including historical) |
| [`docs/GAPS_AND_BUGS.md`](docs/GAPS_AND_BUGS.md) | Maintainers | Known gaps found during doc audit |

---

## Development

```bash
# Backend
cd backend-py
uv run pytest -q
# or from repo root:
npm run test:backend
npm run test:frontend
npm run test              # both
```

The test suite uses `asyncio_mode = "auto"` and **autouse** `isolatedData` so
tests never touch live `data/`. See [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md).

---

## License

MIT.
