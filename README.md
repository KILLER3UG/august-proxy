# August Proxy

August Proxy is a multi-provider AI gateway and agentic workbench. It presents an
OpenAI-compatible Chat Completions API **and** an Anthropic-compatible Messages
API from a single local endpoint, routes each request to a configurable upstream
provider, and ships a full agentic layer on top: a streaming workbench chat loop,
managed tools, persistent memory, a skill system with a curator, sub-agents,
browser automation, and platform gateways (Telegram, Slack, Discord).

It is the successor to an earlier Node.js HTTP bridge. The server is now written
in **Python 3.13** (FastAPI) and lives in [`backend-py/`](backend-py); the
dashboard is a **React + Vite + TypeScript** SPA whose compiled output is served
from [`web-dist/`](web-dist).

---

## Highlights

- **Dual API surface** — `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages`
  (Anthropic) with automatic bidirectional format translation and SSE streaming.
- **30+ built-in providers** — Anthropic, OpenAI, Gemini, Bedrock, OpenRouter,
  Kilo, Opencode, MiniMax, DeepSeek, xAI, and many more, plus custom OpenAI-
  compatible providers added from the UI.
- **Model aliases** — friendly names (e.g. `sonnet`, `claude-sonnet-4-6`) that
  map to a concrete provider + model, with full CRUD, validation, and audit log.
- **Workbench** — a streaming chat engine with a multi-round tool loop, effort /
  thinking-budget resolution, plan-mode approval gate, context compression, and
  fire-and-forget background review / self-evolution.
- **Managed tools** — file ops, shell, web search/fetch, browser automation
  (Playwright), memory, MCP, skills, sub-agents, and self-configuration tools.
- **Memory & learning** — core memory KV, semantic memory, vector search, a
  skill curator with lifecycle management (stale → archive), and an interval-
  gated LLM background review that authors skills from conversations.
- **Platform gateways** — expose the workbench agent over Telegram, Slack, and
  Discord with a two-guard concurrency model (one in-flight turn per session).
- **Observability** — activity log, request tracking, usage stats, and a config
  audit log recording every alias / fallback / agent change.

---

## Repository Layout

```text
august-proxy/
├── backend-py/            # FastAPI server (Python 3.13)
│   ├── app/
│   │   ├── main.py        # FastAPI app, lifespan, router registration
│   │   ├── config.py      # Settings: config.json + providers.json + .env
│   │   ├── adapters/      # Anthropic & OpenAI message/SSE translation
│   │   ├── providers/     # Built-in provider definitions + clients + resolver
│   │   ├── routers/       # /api/* and /v1/* HTTP routes
│   │   └── services/      # workbench, gateway, memory, skills, tools, browser
│   ├── tests/             # pytest suite (asyncio)
│   └── pyproject.toml
├── frontend-src/         # React + Vite + TypeScript dashboard source (if present)
├── web-dist/              # Compiled SPA served by the backend
├── data/                  # Persistent state: config.json, providers.json, DBs, logs
├── skills/                # Bundled SKILL.md packs
├── docs/                  # Project documentation
├── Dockerfile             # Production image
└── docker-compose.yml     # Container orchestration
```

---

## Quick Start

### Prerequisites

- Python **3.13+** (or Docker — see below)
- An API key for at least one provider (Anthropic, OpenAI, OpenRouter, Kilo, …)

### Run with Docker

```bash
cp .env.example .env          # then edit .env and add your API keys
docker compose up --build -d
```

The dashboard is served at **http://localhost:8085**.

### Run locally (development)

```bash
cd backend-py
python -m venv .venv
# Windows:  .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8085
```

For the dashboard, build the frontend (`npm install && npm run build` from the
frontend source) so its output lands in `web-dist/`, or run the Vite dev server
in parallel and proxy `/api` to `:8085`.

### Point a client at the proxy

Any OpenAI- or Anthropic-compatible client works:

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

Configuration lives in `data/` and is split across three files:

| File | Purpose |
|------|---------|
| `data/config.json` | Provider API keys, model aliases, active provider, sub-agent fallback, auxiliary review config, security allowlists |
| `data/providers.json` | User-added custom providers (name, base URL, API format, fetched model lists) |
| `.env` | API keys and runtime env vars (loaded by Docker Compose and Pydantic Settings) |

API keys are resolved per-provider in this order: `config.json → {provider}.apiKey`,
then the provider's declared `env_vars`, then standard env-var patterns. See
[`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the full reference.

---

## Documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [`docs/SETUP.md`](docs/SETUP.md) | All users | Installation, first-run, pointing clients at the proxy |
| [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) | Operators | `config.json` / `providers.json` / `.env` reference |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, memory, gateway |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes |
| [`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, project conventions |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | All users | Common issues and fixes |

---

## Development

```bash
cd backend-py
pytest                         # run the test suite
pytest tests/test_workbench.py # run a single file
ruff check app tests           # lint (if installed)
```

The test suite is async (`asyncio_mode = "auto"`). See
[`docs/DEVELOPER_GUIDE.md`](docs/DEVELOPER_GUIDE.md) for conventions.

---

## License

MIT.
